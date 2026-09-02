# TODOS

## Community fix wave follow-ups (filed 2026-09-01, v0.48.1.0 wave)

- [ ] **P1 — Fix-wave 2: the 27 deferred M-effort verified issues.**
  **What:** the v0.48.1.0 community fix wave triaged every open issue; 22
  were fixed in-wave and 27 verified M-effort issues were deferred to a
  second wave. Full triage records (verdict, rationale, fix sketch, key
  files per issue) live in `.context/fix-wave-triage.json` (gitignored —
  wave working state, not repo content). Deferred issue numbers: #4744
  #4741 #4738 #4732 #4729 #4728 #4696 #4684 #4679 #4653 #4652 #4649 #4620
  #4616 #4609 #4606 #4605 #4603 #4601 #4597 #4589 #4588 #4586 #4578 #4563
  #4558 #4359. (#4636 and #4564 were also triaged M but got fixed in-wave —
  #4636 by the #4279 adoption, #4564 by the #4583 default-write guard.)
  **How:** same discipline as wave 1 — red-proven regression test per fix,
  themed trains, per-train targeted sweeps.
- [ ] **P2 — Enforce pack vocabulary at the put_page choke point, not
  per-surface.** **What:** #4655's write-time vocabulary enforcement
  (`src/core/schema-pack/write-vocabulary.ts`) is wired at three surfaces
  (capture op, add_link op, `gbrain capture` CLI). Any OTHER write path
  that sets an explicit page type (put_page with frontmatter `type`,
  future verbs) bypasses it, and each new surface must remember to opt in.
  **Right altitude:** validate once where every page write converges
  (put_page / import-file boundary), with the same "no resolvable pack =
  no enforcement" fail-open contract and an explicit carve-out for the
  sync importer (existing repo content must never be refused on re-import).
  **Where:** `src/core/ops/pages.ts`, `src/core/import-file.ts`,
  `src/core/schema-pack/write-vocabulary.ts`.
- [ ] **P2 — Default-write guard at the dispatch choke point.** **What:**
  the #4583 guard (`assessDefaultWriteGuard`) is called per-command:
  `sync` refuses, `import` warns, MCP stdio prints a once-per-process
  advisory. Each future write-capable command needs its own call site, and
  the three surfaces already phrase/latch the warning differently.
  **Right altitude:** assess once where source resolution converges (the
  seed_default tier of the resolution ladder in `source-resolver.ts` /
  op-context scope resolution) and let callers choose refuse-vs-warn
  policy, not re-implement detection. **Where:**
  `src/core/source-resolver.ts`, `src/commands/sync.ts`,
  `src/commands/import.ts`, `src/mcp/server.ts`.
- [ ] **P2 — Transcript adapter contract methods instead of per-format
  special cases in discover.ts.** **What:** discovery carries grok-specific
  knowledge inline (the grok-sidecar filter scoped to proven grok trees,
  the session-dir shape); the hermes and openclaw adapters have their own
  inline carve-outs (`.checkpoint.*.jsonl`, wal/shm sidecars). Every new
  harness grows discover.ts. **Right altitude:** extend the
  `TranscriptAdapter` contract with `isSessionFile(path)` /
  `sessionIdMatchesPath(id, path)` (names indicative) so each adapter owns
  its own layout knowledge and discover.ts just asks. **Where:**
  `src/core/transcripts/types.ts`, `discover.ts`, `detect.ts`, each
  adapter.
- [ ] **P3 — Derive the transcripts `--format` allowlist from the adapter
  registry.** **What:** `src/commands/transcripts.ts` hand-maintains
  `FORMATS` (`claude-code`, `codex`, `openclaw`, `hermes`, `grok`,
  `chatgpt`, `claude-export`) parallel to the registry in
  `src/core/transcripts/detect.ts` — adding grok touched both, and the next
  adapter will too. Export the format ids from the registry and derive the
  CLI allowlist (and its error-message enumeration) from it. **Where:**
  `src/commands/transcripts.ts`, `src/core/transcripts/detect.ts`.
- [ ] **P3 — Doctor checks call the runtime resolvers instead of
  mirroring them.** **What:** two wave fixes stopped active drift but left
  mirrors in place: `subagent_capability` (#4575) now walks a shared
  exported precedence LIST from model-config.ts rather than calling
  `resolveModelDetailed` itself (a future resolver behavior change — env
  handling, alias mapping — that isn't expressible as list order drifts
  again), and the `default_source_local_path` gathering wrapper
  re-implements the #2018 write-through collision predicate ("sync.repo_path
  is another source's own working tree") rather than importing the one
  `resolvePageWriteTarget` uses. Mirrors drift; resolvers don't.
  **Right altitude:** call `resolveModelDetailed` (or a read-only wrapper)
  from the check, and export the #2018 collision predicate from
  write-through.ts for the doctor wrapper. **Where:**
  `src/commands/doctor/checks/search-eval.ts` (checkSubagentCapability),
  `src/commands/doctor/checks/default-source-path.ts`,
  `src/core/model-config.ts`, `src/core/write-through.ts`.

### Ship-review deferrals (follow-up from v0.48.1.0 ship review)

Items the three cross-model review rounds surfaced and deliberately deferred
(each has a bounded blast radius today; none blocks the ship). The 27
deferred M-effort issues above are NOT repeated here.

- [ ] **P2 — loops_extract enqueue budget is a racy count-then-insert.**
  **What:** `enqueueLoopsExtraction` (`src/core/google/google-source.ts`)
  counts this source's waiting `loops_extract` jobs, then adds up to
  `LOOPS_EXTRACT_ENQUEUE_CEILING - waiting`. Two concurrent sweeps of the
  same source (a manual `sync --source` racing autopilot) each read the same
  depth and both fill the budget, so the ceiling can be overshot by one
  sweep's worth. Bounded: the per-revision idempotency key
  (`loops:<source>:<slug>:<newestMs>`) means no thread is ever queued twice,
  so the overshoot is spend headroom, never duplicate work. **Right
  altitude:** reserve the budget in the same statement that inserts (an
  `INSERT … SELECT` gated on the live count, or a per-source advisory lock
  around the enqueue), or let `MinionQueue` own a `countWaiting(name,
  predicate)` + `addBounded` pair. **Where:**
  `src/core/google/google-source.ts`, `src/core/minions/queue.ts`.
- [ ] **P3 — Grok per-message timestamps equal the session bounds.**
  **What:** `chat_history.jsonl` carries no per-message times, so the adapter
  stamps every message with `created_at` and only the last with
  `last_active_at` (`src/core/transcripts/grok.ts`). Real source times, never
  fabricated — but a downstream consumer that orders or windows by message
  timestamp sees a flat session. Interpolation would fabricate provenance;
  the honest fix is a per-message `timestamp_source` (or a session-level
  `message_times: 'session_bounds'` stamp) so consumers can tell bounds
  from real per-message times. **Where:** `src/core/transcripts/grok.ts`,
  `render.ts`.
- [ ] **P2 — Unbound legacy atom adoption can collide on slug.** **What:**
  `isCompatibleAtomBinding` (`src/core/cycle/extract-atoms.ts`) treats an
  atom with NO `source_slug`/`source_path` as adoptable by any source page
  (pre-binding-era adoption). Two different source pages whose legacy
  title-only slug coincides therefore both adopt the same unbound atom; the
  second re-extraction rebinds it away from the first. Bounded to the
  pre-binding era (new atoms are always bound). **Right altitude:** stamp
  `source_slug` on first adoption so the second adopter hits the fail-closed
  guard, and surface the conflict as a warn rather than a silent rebind.
  **Where:** `src/core/cycle/extract-atoms.ts` (`resolvePageAtomSlug`,
  `assertAtomImportBinding`).
- [ ] **P3 — Provenance-link failures are counted as provider failures in
  the drain summary.** **What:** in the extract_atoms batch, a failed
  provenance-edge write (`link_source: 'atom-provenance'`, the #3961 bank)
  lands in the same per-item failure records that feed
  `status: 'provider_failure'` in `runExtractAtomsDrain`'s summary, so a
  link-table hiccup reads as an LLM outage in `--json` and in doctor advice.
  **Right altitude:** a typed failure `kind` (`provider` | `provenance` |
  `write`) on the failure record, with `provider_failure` derived from the
  provider kind only. **Where:** `src/core/cycle/extract-atoms.ts`,
  `src/core/cycle/extract-atoms-drain.ts`.
- [ ] **P3 — Cross-modal single-model quorum should stamp a degraded
  verdict.** **What:** with only one of the three default slots keyed, a
  cycle still emits PASS/FAIL from a single judge; the 2-model case is
  already documented as "permanently inconclusive", but the 1-of-3 case
  looks like a full-panel verdict. **Right altitude:** stamp
  `degraded: 'single_model'` (and the reachable slot ids) on the verdict and
  print it in the human summary. **Where:**
  `src/core/cross-modal-eval/runner.ts`, `aggregate.ts`.
- [ ] **P3 — OpenRouter `reasoning_content` promote shim buffers responses
  for every family.** **What:** the compat fetch that promotes DeepSeek's
  `reasoning_content` into an empty `content` reads and re-serializes the
  whole JSON body for every OpenRouter response, not just the deepseek/
  family it exists for (non-JSON bodies pass through byte-identical).
  Correct, but it costs a parse per call and would break a streamed body.
  **Right altitude:** family-gate the promote (the `openrouter-families.ts`
  registry already names the families) and skip the parse otherwise.
  **Where:** `src/core/ai/recipes/openrouter.ts`,
  `src/core/ai/recipes/deepseek.ts`, `src/core/ai/openrouter-families.ts`.
- [ ] **P3 — DRY dedupes left standing.** **What:** three hand-rolled copies
  the review rounds saw but did not fold: `treeNeedsPush` in
  `src/commands/hook.ts` duplicates the dirty-or-ahead probe the
  `bootstrap_push_health` check (`src/commands/doctor/bootstrap-checks.ts`)
  performs; `gatewayClient` in `src/commands/eval-longmemeval.ts` is a
  private `ThinkLLMClient` adapter over the gateway that the other eval
  commands re-derive; and the "waiting jobs for name N" count SQL lives in
  `MinionQueue` (`queue.ts`) AND is hand-rolled (with a `sourceId`
  predicate) in `google-source.ts`. **Right altitude:** one exported helper
  each — a `git-state.ts` push-needed probe, a `gateway-think-client.ts`,
  and `MinionQueue.countWaiting(name, { payloadFilter? })`. **Where:** as
  named.
- [ ] **P2 — `import-file.ts` protected-frontmatter strip is gated on
  `opts.remote === true` (fail-open when `remote` is unset).** **What:**
  the strip that keeps an untrusted writer from planting completion markers
  (`atoms_scan_hash` and friends) only runs when the caller passed
  `remote: true`; a caller that omits `remote` gets the trusted path. The
  repo's trust rule is the opposite (`remote !== false` is untrusted). Every
  current untrusted caller does thread `remote: true`, so this is a latent
  fail-open, not a live hole. **Right altitude:** thread `remote: false`
  explicitly from every trusted importer (sync, CLI import, cycle) first,
  THEN flip the gate to `opts.remote !== false`. **Where:**
  `src/core/import-file.ts`, `src/commands/import.ts`,
  `src/commands/sync.ts`, `src/core/cycle/*`.
- [ ] **P3 — `import.ts` `last_sync_at` stamp skips sources whose
  `local_path` sits under ANY ancestor git repo.** **What:** the #1691 stamp
  detects "git-tracked local_path" via `discoverGitRoot` (walks UP), so a
  plain folder source nested anywhere inside an unrelated git checkout
  (notes under a dotfiles repo, a vault inside `~/code`) never gets stamped
  and stays flagged stale by `sync_freshness`. **Right altitude:** compare
  the discovered git root against the source's OWN `local_path` /
  `sync.repo_path` binding — only a source that sync itself would anchor to
  that root should be excluded. **Where:** `src/commands/import.ts` (the
  clean-run stamp block), `src/core/sync-git.ts:discoverGitRoot`.
- [ ] **P3 — Remote `traverse_graph` flips to both/depth 2 even when
  `link_type` is passed.** **What:** the conservative default keys on
  `direction` alone, so a `link_type`-only remote call also walks
  bidirectionally at depth 2 (pinned as intended, but a caller cannot tell a
  defaulted walk from a requested one). **Right altitude:** stamp
  `depth_defaulted` / `direction_defaulted` in the op's response meta (or the
  stderr note) so agents can see when the walk was clamped for them. **Where:**
  `src/core/ops/links.ts`.
- [ ] **P2 — Pages for the PREVIOUS calendar are not reconciled when
  `g_calendar_id` is re-pointed.** **What:** the sync token now rebinds and
  the switch is logged, but the old calendar's event pages remain in the
  brain until a `--full` reconcile learns to scope calendar pages by calendar
  id. **Right altitude:** stamp `calendar_id` into the rendered event
  frontmatter and reconcile by it, or delete the old calendar's pages on the
  switch behind a confirm. **Where:** `src/core/google/google-render.ts`,
  `src/core/google/google-source.ts:sweepCalendar`.
- [ ] **P3 — CLI `gbrain capture` default slug uses only `--type`.** **What:**
  the CLI lane keeps a frontmatter `type:` via `mergeCaptureFrontmatter`'s
  user-wins fallback, but its default slug (the `inbox/` prefix decision) is
  computed from `--type` alone, so a frontmatter-typed capture without
  `--type` still lands under `inbox/`. The MCP `capture` op now derives both
  the slug and the merge from the validated effective type; align the CLI.
  **Where:** `src/commands/capture.ts`, `src/core/capture-content.ts`.
- [ ] **P2 — `src/core/ops/pages.ts` sits at its 1505-line ratchet ceiling.**
  **What:** the wave's capture-vocabulary enforcement and the get_page alias
  ladder landed together and the ship-review alias-owner fix was a net-zero
  edit to stay under the cap. The next change cannot land without a peel.
  **Right altitude:** peel `capture` (+ `explicitCaptureType` wiring) into
  `ops/pages-capture.ts` and the get_page resolution ladder into
  `ops/pages-resolve.ts`, re-exported through `pages.ts`; lower the TSV row
  in the same commit. **Where:** `src/core/ops/pages.ts`,
  `scripts/module-size-limits.tsv`.

## Eval write-path fix wave follow-ups (filed 2026-08-31; the five CEO-review-deferred items — wave receipt: gbrain-evals Cat 35 bracketing runs, pre-wave baseline dream 70.2% / quote fidelity 54.2% / emission 16/20 at aa820c7f)
## Eval retrieval fix wave follow-ups (filed 2026-08-31, second wave; receipts: LongMemEval recall_all@5 rescore 83.40% + Cat 34 openclaw 9-miss itemization at 6bf8db90)

- [ ] **P2 — facts-lane `idea` kind quality gap.** **What:** Cat 35's facts
  lane scores the `idea` kind at 50.0% salient-unit recall (post-wave receipt
  `receipt-2026-08-31-v0.47.8.0-wave-079941d2.json`) vs the dream lane's 86.7%
  and a 100% verbatim ceiling — the largest facts sub-metric gap. **Why:** ideas
  are the kind users cite back most ("that framing I had last month"). **Where:**
  `src/core/facts/extract.ts` prompt rule for `idea` (line ~200) + eligibility.
  **Receipt-gated:** improvements must be generic prompt/coverage work, never
  tuned on the frozen Cat 35 corpus. **Effort:** M. **Priority:** P2.
- [ ] **P3 — `retrieval_reflex_max_pointers` / `retrieval_reflex_window_turns`
  ablation.** **What:** the two real config knobs on the reflex lane have never
  been swept against BrainBench; the 2026-08 wave closed the openclaw gap via
  the volunteer arm instead, so the pointer-budget knob's marginal value is now
  unknown. **Where:** `src/core/context/reflex.ts:81-129`; sweep via
  `gbrain eval brainbench` at 2/3/4 pointers × 1/4/8 window turns. **Effort:** S.
- [ ] **P3 — `search.dedup_max_per_page` config key.** **What:** config-plane
  analog of the per-call `dedupOpts.maxPerPage` (publicized by the LongMemEval
  `hybrid-diverse` row). Deferred at the 2026-08 CEO review (D3.5): ship only
  with a Class-1-dominant decomposition receipt; folds into the NEXT
  KNOBS_HASH bump (v=29 as of 0.48.1.0 — 28 is the compiled-truth-boost epoch), never its own. **Where:** `src/core/search/dedup.ts`
  + `mode.ts` + `config.ts` registry. **Effort:** S.
- [ ] **P3 — single-pool volunteer resolve micro-opt.** **What:** Arm 1 + Arm 2
  currently issue two resolver calls per windowed turn (pointer budget, then
  wide volunteer pool). One wider resolve split into pointers + gated remainder
  would halve resolver load. **REJECTED for the 2026-08 wave** (outside-voice
  F6): the two-call shape is byte-parity with the proven claude-code lane
  (96/96 at precision 1.0), and a single-pool refactor changes suppression/cap
  interplay on the exact number being published. Re-attempt only with a
  brainbench same-hash proof + latency receipt. Fold in two adjacent
  adversarial-review notes when picked up: (a) the doomed-rung retry — when
  Arm 1 already proved the resolver rung unavailable, Arm 2 still burns its
  budget on a second doomed attempt; (b) neither arm's `withTimeout` cancels
  the LOSING resolver promise (no AbortSignal threading through the rungs),
  so a slow rung's query keeps running server-side after expiry. **Where:**
  `src/core/context/reflex.ts` + `volunteer.ts:volunteerStage`. **Effort:** M.
- [ ] **P3 — LoCoMo benchmark lane (gbrain-evals).** **What:** the comparison
  doc calls LoCoMo "the most interesting unrun benchmark on this page for
  gbrain specifically" (MemPal 96.3–100% R@10 with rerankers, Memori 81.95%).
  New lane = its own wave with corpus freeze + pre-registration. **Where:**
  gbrain-evals `eval/runner/`. **Effort:** L. **Priority:** P3.

## Eval write-path fix wave follow-ups (filed 2026-08-31; the five CEO-review-deferred items — wave receipt: gbrain-evals Cat 35 bracketing runs, pre-wave baseline dream 70.2% / quote fidelity 54.2% / emission 16/20 at aa820c7f. NOTE on ids: this block's E2–E9 ids are scoped to THIS section; an unrelated older "E5" exists under the chennai fix-wave P3 block ("content-level BrainBench leak detection") — cite as "write-path E5" vs "chennai E5" when cross-referencing, per the 2026-08 D3.3 disambiguation)

- [ ] **P3 — E2: chunk-boundary overlap window in splitTranscriptByBudget.**
  **What:** carry ~5% tail overlap between adjacent transcript chunks so salient
  units straddling a boundary aren't structurally invisible to either child.
  **Why:** each chunk's prompt says "do not assume continuity"; a unit split
  across the cut is lost to both. **Blocked on:** post-wave Cat 35 receipts
  showing transcripts actually chunk (`details.synthesis.jobs` >
  `transcripts_processed`) — don't pay the determinism-test churn
  (test/e2e/dream-synthesize-chunking byte-stability) before the receipts say
  it matters. **Where:** src/core/cycle/synthesize.ts splitTranscriptByBudget.
- [ ] **P3 — E3: borderline-band second-pass triage call (#4152 escalation).**
  **What:** when the scalar score lands in [rescue_floor, threshold) and the
  verified-segment rescue does NOT fire, spend one extra focused judge call
  scoring the PEAK passage alone; max(scores) gates. **Why:** the rescue only
  fires when the first judge surfaced verifiable segments; telemetry
  (`triage.rescue_checked` high with `rescue_fired` low across cycles) would
  mean buried signal is still slipping. **Blocked on:** exactly that telemetry
  — the wave's live calibration showed rubric v2 alone lifts the class, so
  don't add spend until production distributions disagree. **Where:**
  runTriagePass processOne + triage-rescue.ts.
- [ ] **P2 — E4: wire-or-delete the three undispatchable eval scaffolds.**
  **What:** src/commands/eval-markdown-greenfield.ts, eval-extract-atoms.ts,
  eval-schema-authoring.ts are registered nowhere in eval.ts/cli.ts dispatch;
  the first two return ok:true with status not_yet_implemented — the exact
  dishonest-envelope class #4198 fixed for synthesize-concepts. **Why:** an
  eval surface that reports ok for work it never ran corrodes trust in every
  other receipt. **How:** either add dispatch + honest not_implemented
  envelopes (ok:false, nonzero exit) or delete the files + their scaffold test.
- [x] **P2 — E5: adaptive-return config plane + KNOBS_HASH fold (its own wave).** **Completed: v0.48.0.0 (2026-09-01)** — all three sub-items shipped: keys registered in KNOWN_CONFIG_KEYS, KNOBS_HASH v=27 fold (gate params + resolved intent class; adaptive-on calls cache), AdaptiveQueryIntent gained 'concept' (hybrid.ts coercion dropped).
  **What:** (a) the four search.adaptive_return* keys are a DB-config no-op
  (not in KNOWN_CONFIG_KEYS; config-db-merge folds only cycle.*; GBrainConfig
  has no search block) — register + fold or move onto the ModeBundle ladder
  like autocut; (b) fold gate params into knobsHash (append-only,
  KNOBS_HASH_VERSION bump) so adaptive-on calls cache (today gate-on ==
  cache-cold, hybrid.ts skipCache); (c) widen AdaptiveQueryIntent with
  'concept' (drop the hybrid.ts:2141 coercion). **Why:** prerequisite for the
  cross-surface ablation + any default flip (TODOS v0.41.33.0 section).
- [ ] **P3 — E8: quote-verify coverage is partial on the agentic fallback path.**
  **What:** the verify pass scopes to pages whose slug carries the transcript's
  hash6 (`ref.slug.includes('-' + hash6)`), but that suffix is enforced
  fail-closed only in ONESHOT mode (subagent-oneshot.ts `oneshot_slug_suffix`
  check). An agentic-fallback child that drops the suffix creates a page the
  verify pass skips and mislabels `skipped_preexisting` — coverage is silently
  thinnest on the path most likely to produce sloppy output. **How:** enforce
  the suffix server-side in the subagent put_page tool for agentic children
  too, or at minimum split a `skipped_unbound_new_page` counter with a stderr
  warn so the gap is observable. **From:** eval fix wave red-team review.
- [ ] **P3 — E9: no retrofit path for unverified dream pages.**
  **What:** quote verify only covers the CURRENT run's writtenRefs. A crash or
  abort between child completion and the verify pass strands pages with
  unrepaired quotes forever — and the TRIAGE_VERSION 2 bump widens the window
  (a transcript whose children completed under v1 may re-judge below the gate
  under v2 and never re-enter the fan-out). **How:** an operator command
  (`gbrain dream verify --recheck`) over `frontmatter->>'dream_generated'`
  pages matched to transcripts by raw_source/hash6, or a per-page verified
  marker in the provenance stamp so a later cycle can find and repair them
  regardless of the gate's current verdict. **From:** eval fix wave red-team
  review.
- [ ] **P3 — E7: LLM grounding judge on dream pages (TRUSTMEM-style).**
  **What:** an opt-in verify pass that judges every dream-page claim against
  its source transcript (coverage/preservation/faithfulness), beyond the
  mechanical quote/numeric checks the wave shipped. **Why:** the wave's
  synthesize-verify.ts repairs QUOTES mechanically at $0; ungrounded
  non-quote claims (hallucination ~14%) need semantics. Field context:
  2026 write-path research (TRUSTMEM, arXiv 2606.25161) validates
  verify-at-write. **Costs:** per-page LLM spend on every nightly cycle —
  needs spend.posture gates + a config default OFF. **Where:** extend the
  synthesize-verify pass; reuse normalizeForGrounding + the receipt fields.

## Fix-wave follow-ups (filed 2026-08-29, follow-up from the v0.47.x fix wave)

- [ ] **P1 — #4599 root-cause instrumentation loop.** **What:** the embed
  --stale hang's root cause is UNPINNED (heartbeat theory retracted by the
  reporter on-thread 2026-08-28; the stall watchdog only bounds it). Build the
  instrumented binary the reporter offered to run (near-daily repro rig):
  candidate class is a lost promise in the drain — postgres.js pool +
  PgBouncer transaction mode + idle_timeout interplay (both repros on port
  6543). **Where to start:** the drain in src/commands/embed.ts +
  src/core/embed-stall.ts telemetry; wrap pool acquisition with settle-time
  tracing.
- [ ] **P2 — pricing-overrides sweep of the remaining capped BudgetTracker
  sites.** **What:** #4571/#4633 wired `loadPricingOverrides` into
  embed-backfill + the three Conversation Facts entry points, but ~6 capped
  sites still omit it (extract-atoms, skillopt, reindex-code, remediation,
  eval-contradictions, brainbench) — 3rd recurrence of the class since #4312.
  **Fix shape:** a factory helper (tracker-with-overrides) or a grep guard so
  a new capped BudgetTracker without overrides fails at PR time.
- [ ] **P2 — `<think>`-strip sweep of hand-rolled LLM JSON parsers.** **What:**
  #4640 fixed parseLlmJson + the facts/atoms extractors and exported
  `stripReasoningBlocks`, but ~13 hand-rolled brace-scan sites remain
  (judges, grade-takes, drift, voice-gate, calibration-profile, chronicle,
  facts/classify, loops-extract, skillopt x3, eval json-repair, think/index);
  propose-takes.ts carries its own duplicate regex to converge.
- [ ] **P2 — verify gpt-5.6-terra / gpt-5.6-sol canonical prices.** **What:**
  while live-verifying luna (#4560), OpenAI's official pricing page listed
  terra at $2.00/$12.00 and sol at $4.00/$20.00 vs CANONICAL_PRICING's
  $2.50/$15.00 and $5.00/$30.00. Repo overprices → budget gates throttle
  early (safe direction, no overspend), but the table should be re-verified
  and corrected with its own `price_last_verified` refresh.
- [ ] **P1 — #4616 PGLite vector-search reachability.** **What:** recently
  written pages can be unreachable by vector search while doctor reports 100%
  embedding coverage (suspected HNSW divergence after the auto WAL-repair;
  heap vectors intact — recoverable, not lossy). **Fix shape (from triage):**
  PGLite branch for vector-index dropAndRebuild + a contract-first
  `reindex_vector` admin op + doctor self-recall reachability probe (ANN-query
  the K most recent chunks with their own vectors) + rebuild-or-flag after WAL
  repair. Design care: probe false positives (exact-scan columns, empty
  index); inline-vs-queued rebuild after repair.
- [ ] **P3 — hoist prompt-too-long helpers to a shared module.** **What:**
  #4675 has subagent-oneshot.ts import isPromptTooLongError/
  extractPromptTooLongDetail from subagent.ts while subagent.ts imports
  runSubagentOneshot — a call-time-safe but structurally fragile import cycle.
- [ ] **P3 — surface-aware MCP initialize instructions.** **What:** the #4643
  contract constant references get_page/put_page/list_skills/get_skill, which
  don't exist on `--surface verbs`; serve the verb-appropriate contract per
  surface.
- [ ] **P3 — per-source sync.exclude scoping.** **What:** #4667's persisted
  exclude scope is global (union-only widening across every source); a
  per-source key was the author's own follow-up note.
- [ ] **P3 — skills-doc note on capture-time vs retroactive backlink dating.**
  **What:** #4552/#4595 made backlink REPAIR insert undated "Referenced by"
  rows (retroactive dating is forgery), while live capture keeps dated
  "Referenced in" timeline entries — one line in skills/_brain-filing-rules.md
  + quality.md + signal-detector so agents don't "fix" the divergence.
- [ ] **P3 — unify the slug grammar repo-wide + surface legacy invalid slugs.**
  **What:** put_page now validates via a widened local grammar
  (dots/underscores as continuation chars) while cjk.ts's PAGE_SLUG_SEG stays
  narrower for cite-render/slug-registry/dream — unify deliberately. Also add
  a doctor/lint check listing pages whose slug fails validatePageSlug (Dream
  historically wrote space-slugs; those rows are now un-updatable via
  put_page) with rename guidance.
- [ ] **P3 — engine-parity e2e open_loops reset.** **What:** the parity suite
  doesn't reset open_loops between runs, so a leftover row in a shared
  DATABASE_URL database flakes the round-trip test (observed during #4587
  verification; fresh DB → green). Add a per-run cleanup or unique key.

## Schema-bootstrap coverage follow-ups (filed 2026-08-29, follow-up from the #4657 P0 fix)

- [ ] **P3 — Extend the blob forward-reference gates beyond CREATE INDEX.**
  **What:** `test/schema-bootstrap-coverage.test.ts` now gates CREATE INDEX
  column references on BOTH schema blobs (PGLite A2 check + the #4657
  Postgres-blob class-closure gate), but forward references through
  constraints, views, trigger bodies, and partial-index WHERE clauses are
  not parsed. **Why:** the #4657 class (4th recurrence) proved blob-only
  forward references break zero locally-runnable tests; the remaining DDL
  forms are the same shape through a different syntax. **Where to start:**
  extend `parseIndexColumnReferences` siblings for `CHECK`/`REFERENCES`/
  `CREATE TRIGGER` bodies against `SCHEMA_SQL` + `PGLITE_SCHEMA_SQL`, reuse
  `buildIndexRefCoveragePredicate`, keep the exemption-with-rationale bar.

## Gmail open-loop engine follow-ups (filed 2026-08-25, follow-up from the gmail-open-loop-engine wave)

- [ ] **P1 — gbrain.io hosted OAuth relay: server build + CASA clock.**
  **What:** implement the consent relay specified in
  `docs/designs/HOSTED_OAUTH_RELAY.md` (session create → server-side exchange
  → one-time claim, zero retention; refresh endpoint; `/api/creds/import`).
  The CLI half already ships (`src/core/creds/relay-client.ts`, gated by
  `GBRAIN_OAUTH_RELAY_URL`; conformance spec = `test/creds-relay-client.test.ts`).
  **Why:** cuts "connect Gmail" from ~8 min (BYO console dance) to ~30 s.
  **Blocker to start NOW regardless of build order:** Google CASA security
  assessment for the restricted `gmail.readonly` scope — weeks-to-months lead
  time; brand verification + privacy policy + scope justification.
  **Effort:** server M; verification track L (calendar time).

- [ ] **P2 — Gmail Pub/Sub push lane.** **What:** `users.watch` + a webhook
  route beside `POST /webhooks/github` for instant thread refresh (the third
  freshness layer github already has). **Where to start:**
  `src/commands/serve-http.ts` webhook cluster; `runGoogleSync` already
  supports targeted thread processing. **Effort:** M.

- [ ] **P2 — Fulfillment-by-reply auto-close for commitment loops.**
  **What:** v1 closes commitment loops manually or by staleness; detect
  "I sent the deck" replies and close `commitment_owed_by_me` loops
  automatically (LLM judge over the closing message, all-or-nothing barrier).
  **Where to start:** `src/core/google/loops-extract.ts` (extend the judge
  schema with `fulfills` references). **Effort:** M.

- [ ] **P3 — Dropbox + Mac-companion credential providers.** **What:** the
  vault + provider registry (`src/core/creds/`) ship Google-only; add
  `providers/dropbox.ts` (OAuth2) and a bearer-token provider for the Mac
  companion app (iMessage/Photos/Health context). The vault schema already
  carries `kind: 'bearer' | 'api_key'`. **Effort:** S each.

- [ ] **P3 — Remote `open_loops` auth predicate refinement.** **What:** v1
  redacts verbatim quotes for every `ctx.remote !== false` caller; hosted
  gbrain.io will want an "authenticated owner" predicate that widens evidence
  for the brain's own user over HTTP. **Where to start:**
  `src/core/ops/loops.ts` redaction seam; OAuth scopes in
  `src/core/oauth-provider.ts`. **Effort:** M.

- [ ] **P3 — Co-recipient-reply configurability + loop-detect corpus growth.**
  **What:** the detector treats any later message as answering an inbound ask;
  make co-recipient replies configurable (`loops.corecipient_answers`) and
  keep growing the labeled fixture corpus (`test/google-loop-detect.test.ts`)
  with every observed false-positive class. **Effort:** S, ongoing.

- [ ] **P3 — Turn-flip close precision: auto-reply + third-party + spoof
  hardening.** **What:** any non-noise counterparty message closes
  `unanswered_outbound` as `reply_detected` — an OOO auto-reply
  (`Auto-Submitted`/`X-Autoreply` headers, currently not fetched), a
  third-party chime-in from someone other than the loop's counterparty, or a
  message spoofing one of `myAddresses` all count as answers. Fetch the
  relevant headers in `google-clients.ts:getThread` and teach
  `loop-detect.ts` to hold instead of close on them. **Effort:** M
  (adversarial-review follow-up from the v0.47.0.0 wave).

- [ ] **P3 — Commitment dedup on model-worded text.** **What:**
  `commit:<sha8({t,d,x: text.toLowerCase()})>` mints a NEW loop row whenever
  re-extraction rephrases the commitment — duplicates accumulate over a
  thread's life. Consider per-(thread, direction) replace semantics or fuzzy
  dedup before upsert (`src/core/google/loops-extract.ts`). **Effort:** M.

- [ ] **P3 — Delta lane history pagination cap has no partial mode.**
  **What:** `listHistoryThreadIds` throws at the 500-page safety cap (a
  partial history drain must not advance the cursor), so an extremely busy
  account re-throws each run until the historyId expires (~1 week) and the
  bounded windowed fallback takes over. Consider chunked history draining
  with an intermediate cursor commit. **Effort:** M, affects only extreme
  volumes. Related: same-second sibling messages at an exact whole-second
  backfill floor can be skipped across the cap boundary (rare; needs
  overlap-by-1s on the `before:` bound).

- [ ] **P2 — Recipe readiness checks don't see the credential vault.**
  **What:** the email/calendar/credential recipes' `any_of` readiness gate
  only recognizes `GOOGLE_CLIENT_ID` in the env
  (`src/commands/integrations.ts` branchSatisfiedByEnv +
  `src/commands/features.ts` RECIPE_META), so a vault-only connect
  (`--client-json`) leaves all three recipes showing "not configured" in
  `gbrain integrations list` while the connector works fine. Add a
  `credential_exists` check type that consults the vault
  (`src/core/creds/vault.ts` list()). **Effort:** S (flagged by
  /document-release on the v0.47.0.0 wave).

- [ ] **P3 — Per-loop staleness marker for mixed-freshness brains.**
  **What:** `open_loops.stale` is true only when EVERY google source is
  stale; a brain with one fresh and one 3-week-dead source presents the dead
  source's loops as fresh. Attach per-loop `source_stale` (the per-source
  flag already computed in `googleSourceFreshness`) and render it in the
  digest. **Effort:** S.
## v0.46.32.0 post-release doc audit follow-ups (filed 2026-08-26)

- [ ] **P2 — `gbrain import --include-hidden` is accepted but silently ignored.**
  **What:** either parse `--include-hidden` in the import CLI and thread it into
  `collectSyncableFiles` (which already takes `includeHidden` — the sync path uses
  it), or drop the flag from import's registry surface. **Why:** the generated
  flag registry lists the flag for `import`, so the CLI accepts it without effect
  — a user waiving a dot-directory on a one-shot import gets silent exclusion,
  the exact silent-kill class #4027 fixed for sync. **Context:** found by the
  v0.46.32.0 cross-model doc review (follow-up from v0.46.32.0);
  `src/commands/import.ts` never reads the flag, `src/cli.ts` passes bare args to
  `runImport`; the library plumbing is done, only arg parsing + one test are
  missing. **Depends on:** nothing.

## Daemon env-file lane follow-ups (#2608 / #4443 takeover, filed 2026-08-21)

- [x] **P3 — Fix the stale `config set` DB-plane claim in the install docs.**
  **Completed:** v0.46.31.0 (2026-08-26). The db-availability wave's config-plane
  work rewrote the `INSTALL_FOR_AGENTS.md` and `docs/INSTALL.md` copy to document
  the file-plane routing, and the post-push docs sweep fixed the last remaining
  copy of the stale claim in `docs/guides/embedding-migration.md`
  (`gbrain config set voyage_api_key` is file-plane routed via
  `FILE_PLANE_API_KEYS`, which `mergedProviderEnv` reads). `bun run build:llms`
  regenerated in the same commits.

- [ ] **P3 — Refresh file-plane keys in the autopilot tick.** **What:** call
  `refreshGatewayEnvFromFilePlane()` (`src/core/ai/gateway.ts:~497`, today only
  called from `src/commands/jobs.ts`) from the autopilot tick so a key added to
  `~/.gbrain/config.json` after boot is picked up without a daemon reload.
  **Why:** shrinks the restart-required window the #2608 boot warning documents.
  **Where to start:** autopilot tick body next to the existing health probe.
  **Effort:** S.

- [ ] **P3 — Doctor check for a stale (pre-env-lane) daemon wrapper.** **What:**
  a doctor check that reads `<gbrainDir>/autopilot-run.sh` and warns when it
  lacks the env-file sourcing line (installed before v0.46.2x, binary upgraded,
  wrapper never regenerated). **Why:** self-upgrade swaps the binary but never
  the wrapper; the boot warning covers the no-key case, doctor should cover the
  wrapper-drift case. **Where to start:** `src/commands/doctor.ts` filesystem
  checks; `writeWrapperScript` in `src/commands/autopilot.ts`. **Effort:** S.

- [ ] **P3 — launchd/systemd log paths ignore `GBRAIN_HOME`.** **What:**
  `generateLaunchdPlist` and `generateSystemdUnit` hardcode
  `~/.gbrain/autopilot.{log,err}` (`src/commands/autopilot.ts` plist/unit
  templates) while the wrapper, lock, and env file all resolve through
  `gbrainPath()`. **Why:** on a `GBRAIN_HOME` install the daemon's diagnostics
  land in a different directory than every doc and status command names —
  pre-existing, but the #2608 boot warning is the first feature whose
  remediation depends on users finding autopilot.log. **Where to start:** the
  two generators + `showStatus` log-tail readers. **Effort:** M (migration for
  existing installs).

- [ ] **P3 — In-process env-file fold for foreground/doctor parity.** **What:**
  parse simple `KEY=value` lines of `<gbrainDir>/env` before `configureGateway`
  (`src/cli.ts:~3298`) so foreground runs and doctor see the same keys the
  daemon wrapper sources. **Why:** today an env-file-only key makes doctor
  report keyless while the daemon is keyed — the inverse of #2608's trap.
  Rejected as the PRIMARY fix because process-level vars
  (`NODE_EXTRA_CA_CERTS`) must exist before boot, which only wrapper sourcing
  delivers; a parity fold is additive. **Where to start:** `src/cli.ts`
  connectEngine preamble; reuse the template's grammar (export-optional
  KEY=value). **Effort:** M.

## Serve-delegated sync follow-ups (v0.46.24.0)

- [ ] **P3 — `sync --all` under delegation.** **What:** delegate a multi-source
  sync per-source through a live serve. **Why:** v0.46.24.0 refuses `--all`
  under a live serve — the client has no engine to enumerate sources, and the
  PGLite fan-out is serial anyway. **Context:** the serve could enumerate its
  own sources and run per-source delegated jobs sequentially (the runner is
  single-flight by design), or the client could gain a `sync_sources` IPC kind.
  Per-source `gbrain sync --source X` delegates today, so this is convenience,
  not capability. Start: `src/commands/sync-delegate.ts` (the `--all` refusal),
  `src/core/serve-sync-runner.ts`. Effort: M (CC: S). Priority: P3.
- [x] **P3 — `serve --http` sync IPC.** DONE (#4474): the stdio IPC block is
  extracted to `src/mcp/resolve-ipc-binding.ts` (`bindResolveIpcForServe`) and
  both serve transports bind it — resolve/turn_context/context_pack AND the
  sync/sweep kinds now work under `serve --http`. Pinned by
  `test/resolve-ipc-binding.test.ts`.
- [ ] **P3 — delegated post-sync steps.** **What:** the direct-CLI post-steps
  (`manageGitignoreAtGitRoot`, the extraction-lag nudge) don't run for
  delegated syncs. **Why:** both need an engine or repo-adjacent context the
  client doesn't have; both already have "defer to next clean sync" postures,
  so nothing breaks — but a brain synced ONLY through delegation never gets
  the .gitignore management. **Context:** run them serve-side after a done
  job, or client-side without an engine where possible. Start:
  `src/core/serve-sync-runner.ts` (post-done hook). Effort: S. Priority: P3.
- [ ] **P3 — N-process delegation hammer in tests/heavy/.** **What:** a
  `tests/heavy/serve_sync_delegation.sh` modeled on `sync_lock_regression.sh`:
  one serve + M concurrent `gbrain sync` clients, assert one delegated job at
  a time (`busy` for the rest), no leaked lock rows, bounded MCP latency
  during the run. **Why:** the e2e covers the arc; the hammer covers
  contention shapes. Effort: M. Priority: P3.


## Key-aware model routing wave follow-ups (filed 2026-08-17; plan: ~/.claude/plans/system-instruction-you-are-working-enchanted-lark.md)

- [ ] **P2 — More providers in `PROVIDER_TIER_DEFAULTS` (+ discovery).** **What:**
  extend the key-aware tier-default table (src/core/model-config.ts) beyond
  anthropic/openai — google, deepseek, groq, openrouter each need a curated
  per-tier model choice, and ideally a latest-model discovery adapter like
  OpenAI's (`src/core/ai/openai-latest.ts` — provider models endpoint →
  grammar-ranked, priced-only, cached; Anthropic also has GET /v1/models).
  **Why:** a GOOGLE_GENERATIVE_AI_API_KEY-only install still resolves tier
  defaults to Anthropic (unservable) and degrades to the honest keyless path
  instead of using the key it has; and every static entry rots the way the
  openai gpt-5.2 pin did. **Context:** the mechanism is done — one table
  entry per provider; the work is choosing tier grammar per provider and
  asserting recipe capability fit (tool support for subagent). Start:
  `PROVIDER_TIER_DEFAULTS` + `test/model-config.serial.test.ts` matrix +
  the openai-latest ranking pattern. **Effort:** S-M per provider.
  **Depends on:** nothing.
- [ ] **P3 — Key-aware `DEFAULT_SYNOPSIS_MODEL` (page-summary).** **What:**
  `src/core/page-summary.ts` pins the synopsis default to Anthropic Haiku.
  **Why deferred:** the model id feeds `computeCorpusGeneration` hashing
  (contextual-retrieval-service.ts) — making it key-dependent churns the
  corpus generation hash per-environment. Needs a hash-stable design (e.g.
  exclude the model from the hash, or version the generation) before touching.
  **Effort:** M.
- [ ] **P3 — Structured agent-side extraction protocol.** **What:** upgrade
  the keyless `extract_facts` envelope (skipped: extraction_unavailable +
  prose `agent_action`) into a structured handoff (taxonomy fields, per-fact
  write-back contract, conformance test). **Why:** the prose instruction
  works but agent compliance is unmeasured; a typed contract makes keyless
  extraction quality testable. Start: `src/core/ops/facts.ts` envelope +
  `skills/brain-ops/SKILL.md`. **Effort:** M.
- [ ] **P2 — Durable-job parking/requeue without consuming attempts.**
  **What:** facts-absorb jobs that fail `chat_unavailable` retry 5× at a 60s
  exponential base, then park as visible failures; a true "parked —
  reactivate when a key appears" state would survive arbitrarily long
  operator delay without manual `jobs retry`. **Why:** config drift is fixed
  on human timescales; retry windows are minutes. Start:
  `src/core/minions/queue.ts` (new status or delayed-until-capability
  semantics). **Effort:** M-L.
- [ ] **P2 — Chat-side extraction budget/rate cap.** **What:** the spend
  system (docs/operations/spend-controls.md) is embedding-focused; the facts
  backstop has no per-source budget or rate cap on chat calls. **Why:** a key
  activates uncapped extraction on eligible writes; today's controls are the
  kill switch + model pins only (disclosed in CHANGELOG). Start: a leaser like
  the contextual-reindex Haiku rate-leaser, keyed per source. **Effort:** M.
- [ ] **P2 — Route `gbrain config set *_api_key` to the file plane.** **What:**
  `config set <provider>_api_key` writes the DB plane, which
  `loadConfigWithEngine()` deliberately never merges for key fields
  (documented at src/core/config.ts) — so those writes never reach the
  gateway, and the per-job worker re-fold (src/commands/jobs.ts
  refreshGatewayForJob) only sees file-plane edits. **Why:** closes a
  long-standing operator trap AND makes worker key-refresh complete. Start:
  `src/commands/config.ts` set handler (redirect key fields to the 0600
  config.json write path). **Effort:** S-M.
- [ ] **P2 — Doctor `facts_extraction_health` can't see the WORKER's env.**
  **What:** the zero-rows branch gates on `isAvailable('chat', model)` in the
  doctor process; a launchd worker with a different env (no keys) skips every
  extraction calmly while a keyed operator shell's doctor reports healthy.
  Sharper edge (adversarial review): the calm skip COMPLETES the job, and the
  queue's content-hash idempotency then returns the completed row for
  identical resubmissions — so those turns' facts are never extracted even
  after the key is repaired, unless the page changes.
  **Fix direction:** keyless-skip in the worker records a low-volume marker
  (job result field or daily absorb row) doctor can read — doctor already
  reads job results. Start: src/commands/jobs.ts facts-absorb handler +
  src/commands/doctor.ts facts_extraction_health. **Effort:** S-M.
- [ ] **P3 — Cap/dedupe absorb-log rows on keyed extraction failure.**
  **What:** a keyed-but-failing extraction writes one ingest_log row PER
  RETRY ATTEMPT (5 per job); a 10k-page sync during a revoked-key day yields
  ~50k rows + 10k parked jobs. **Fix direction:** one absorb row per job
  (stamp attempt count into it), or a per-source daily cap. Visibility was
  the goal; unbounded growth wasn't. Start: src/core/facts/backstop.ts
  `surfaceExtractionFailure` call sites. **Effort:** S.
- [ ] **P2 — Classify provider HTTP status into extraction retry policy.**
  **What:** `FactsExtractionError` deliberately drops the provider error body
  (redaction), but it also drops the STATUS — the worker retries 401s (
  permanent), 429s (needs longer backoff), and 5xx (transient) identically,
  5 attempts each. **Fix direction:** carry a sanitized `status?: number` on
  the typed error (a number can't leak a key), map 401/403 →
  UnrecoverableError (park immediately with the fix hint), 429 → longer
  backoff. Start: src/core/facts/extract.ts provider_error arm +
  src/commands/jobs.ts facts-absorb handler. **Effort:** S-M.
- [ ] **P2 — Live-key e2e for latest-model discovery.** **What:** discovery
  is off in ALL test lanes (provider-keys preload); the authenticated
  /v1/models path, endpoint override, fingerprint switch, and real response
  shape have zero e2e coverage — only the manual scratch-HOME smoke. **Fix
  direction:** a skip-gated e2e (runs only when OPENAI_API_KEY + an explicit
  opt-in env is set, like the live embed parity tests) asserting a real
  refresh lands priced tiers. Start: test/e2e/ + scripts/run-e2e.sh
  scrub-allowlist for GBRAIN_MODEL_DISCOVERY. **Effort:** S.
- [ ] **P3 — mtime-memoize `loadConfig()`.** **What:** key-aware resolution
  put sync read+parse of config.json on per-resolution hot paths
  (`resolveTierDefault` step 7, `classifyUnavailable`). Bulk syncs multiply
  it. **Fix direction:** the exact mtime-keyed memo pattern in
  src/core/ai/openai-latest.ts `readCacheFile`. Same cost profile as the
  old `hasAnthropicKey` precedent, so P3 not P2. Start: src/core/config.ts
  `loadConfig`. **Effort:** S.
## Dream freshness split follow-ups (v0.46.20.0)

- [ ] **P2 — automatic background lane for `SOURCE_BACKGROUND_PHASES`.**
  **What:** a per-source scheduled lane for the LLM-backed/unbounded source
  phases (extract_atoms, consolidate, propose_takes, enrich_thin,
  schema-suggest, conversation_facts_backfill) that the v0.46.20.0 freshness
  split removed from automatic scheduling on multi-source brains. **Why:**
  today those phases run only on explicit `gbrain dream --source X --phase …`
  invocation; backlogs (atoms, consolidation) grow silently between manual
  runs. **Design constraints (verified against code during the #4250
  review):** MUST be per-source jobs — background phases scope to ONE source
  per cycle (`cycle.ts` extract_atoms uses `cycleSourceId ?? 'default'`), and
  per-source jobs hold the correct `gbrain-cycle:<source>` locks (a
  global-maintenance-job version provably covers at most one source and its
  bare `gbrain-cycle` lock does not conflict with per-source freshness
  cycles). Needs its own cadence + stamp key (e.g.
  `last_source_background_at`), lower dispatch priority than the freshness
  lane, and the queue-boundary normalization in the `autopilot-cycle` handler
  relaxed for the new job name (or a dedicated handler). **Blocked by:** the
  abort-signal threading TODO below (P2 — BasePhaseOpts + dream generators);
  extract_atoms/consolidate accept neither deadline nor abort today, so a
  background job can't exit cleanly at its deadline. **Additional constraints
  from the #4250 ship-stage adversarial reviews:** (a) the lane applies to
  EVERY brain with registered sources, including single-source ones (the
  legacy full-cycle fallback fires only when the sources table is empty, so
  a one-source brain also loses automatic background work today); (b) the
  taxonomy is scheduling-intent, not runtime scoping — consolidate,
  enrich_thin, and conversation_facts_backfill iterate the whole brain
  internally, so the lane must run those ONCE per tick, never once per
  source (concurrent per-source invocations share no lock and consolidate's
  take-row assignment can race); (c) the maintenance job runs synthesize →
  patterns WITHOUT the source-scoped extract phase in between, so patterns
  reads a graph that hasn't materialized the just-synthesized links until a
  later freshness cycle runs extract — the lane should sequence extract (or
  an equivalent materialization) between them; (d) mixed-once synthesis
  writes attribute to the repoPath-resolved source rather than fanning out
  attribution per source. Effort: L (CC: M). Priority: P2.
- [ ] **P2 — maintenance-lane structure: ordering, keeper wall, slot
  contention.** **What:** three ship-stage adversarial findings about the
  single global-maintenance job, to resolve alongside (or inside) the
  background lane above. (a) MAINTENANCE_PHASES runs synthesize →
  resolve_symbol_edges → patterns with NO extract phase between synthesize
  and patterns, so patterns reads a graph that hasn't materialized the
  just-synthesized links until a later freshness cycle runs extract; (b)
  synthesize runs FIRST in the job, so a large synthesis backlog + the job
  keeper's timeout starves the brain-wide hygiene phases behind it (embed,
  orphans, purge) and `last_global_at` never stamps — the next window
  re-dispatches into the same wall (consider global-before-mixed ordering or
  splitting mixed into its own job; note runCycle executes in canonical
  order, so this needs more than reordering the list); (c) freshness jobs
  share `queue: 'default'` with the hours-long maintenance job — with low
  worker concurrency, per-source freshness queues behind maintenance
  synthesis, re-coupling what this release decoupled (a fanout-vs-concurrency
  doctor check exists but does not cover this pairing). Effort: M-L (CC).
  Priority: P2.
- [ ] **P2 — protected-phase submission bypass via unprotected job names.**
  **What:** `synthesize`/`patterns`/`consolidate` are PROTECTED_JOB_NAMES so
  scoped remote callers can't burn LLM budget, but `autopilot-global-
  maintenance` (and no-source `autopilot-cycle`) accept arbitrary
  `job.data.phases` — a write-scoped remote submitter can reach synthesize
  through the global job's payload. v0.46.20.0 narrowed the surface
  (per-source payloads normalize to freshness; maintenance payloads intersect
  with MAINTENANCE_PHASES) but synthesize is legitimately IN
  MAINTENANCE_PHASES. **Fix shape:** protect these job names, or require
  `allowProtectedSubmit` when a payload names a protected-equivalent phase.
  Pre-existing exposure, narrowed but not closed by this release. Effort: S-M
  (CC). Priority: P2.
- [ ] **P3 — freshness-stamp gate: require ≥1 freshness-phase success.**
  **What:** `runCycle` stamps `last_source_cycle_at`/`last_full_cycle_at`
  when ANY phase ran and status ∈ {ok, clean, partial} — e.g. `--phase
  orphans --source X` (global phase, source-narrowed) stamps source
  freshness. Also note the semantic drift: `last_full_cycle_at` now stamps
  after a 6-phase deterministic cycle, so any reader treating it as "the
  full cycle ran" reads more than it means (KEY_FILES documents it as a
  legacy-reader alias). **Why:** pre-existing looseness (predates #4250,
  which tightened zero-phase runs and stopped all-failed cycles from
  stamping); sharpening further re-opens the #2549 freshness-poisoning
  debate (a too-strict gate starves the dispatch loop) — design carefully.
  Start: `src/core/cycle.ts` stamp gate. Effort: S (CC). Priority: P3.
- [ ] **P3 — peel the cycle.ts KEY_FILES mega-entry.** **What:** the
  `src/core/cycle.ts` entry in `docs/architecture/KEY_FILES.md` is a ~11KB
  single line carrying six unrelated concern clusters; every cycle-area PR
  now pays a manual three-way merge on it (#4250 did). `phase-scope.ts` got
  its own entry in v0.46.20.0; peel the rest (lock/refresher cluster,
  extract-atoms batching, by-mention resume → op-checkpoint entry, doctor
  hints) into per-module entries. Effort: M (CC). Priority: P3.
## Dream-wave follow-ups (#4216 oneshot + #4194/#4217/#4088/#4087/#4155/#4201)

- [ ] **P2 — gateway-loop truncation note for `length` WITH tool calls.**
  **What:** the legacy Anthropic path injects a truncation note into the
  tool-result turn when a `max_tokens` stop arrives mid-tool-round
  (subagent.ts ~:835) so the model re-issues the dropped call; the gateway
  toolLoop has no equivalent — #4088 fixed only the zero-tool-call honesty
  arm. Add the same note-injection to `gateway.ts:toolLoop`. **Why:** a
  capped tool turn on the gateway path silently drops the trailing calls.
  **Effort:** S. **Priority:** P2.
- [ ] **P2 — synthesis-quality eval lane (oneshot vs agentic).** **What:** a
  `gbrain eval` suite scoring synthesis output (faithfulness/link quality/
  self-containedness) on a synthetic fixture corpus, following the
  takes-quality 3-judge template + the eval-chronicle deterministic-gold
  pattern; wire `details.synthesis.fallback_reasons` into the receipt.
  Adjacent: #4198 (synthesize-concepts evaluator — v0.46.28.0 made the stub
  an honest not-implemented exit-1 scaffold; the parity-baseline evaluator
  itself is still unbuilt). **Why:** the
  oneshot default currently leans on the soak + fallback telemetry; CI
  should catch a quality regression, not output review. **Effort:** L.
  **Priority:** P2.
- [ ] **P3 — `dream.patterns.max_turns` config.** patterns.ts hardcodes
  `max_turns: 30`; make it a registered key mirroring
  `dream.synthesize.max_turns`. **Effort:** S.
- [ ] **P3 — doctor/advisor collector for oneshot fallback rate.** Surface
  `details.synthesis.fallback_jobs / oneshot_jobs` over the last N cycles;
  advise the agentic revert dial when the rate stays high. **Effort:** S.
- [ ] **P3 — evaluate oneshot for the patterns phase.** One job per cycle so
  the latency win is small, but the pattern-page output contract is just as
  structured. **Effort:** M.
- [ ] **P3 — shared collectPutPageSlugs (ENG-3, deferred at C9).** synthesize
  and patterns keep private ledger collectors; they differ materially
  (chunk-slug rewrite + jobRawSource threading vs the simple patterns copy),
  so unification was deferred rather than forced late in the wave. Unify
  when patterns gains chunking or the collectors next change together.
  **Effort:** M.
- [ ] **P3 — relax the handler-entry capability gate for oneshot jobs
  (ENG-1).** The oneshot attempt needs no tools, so a tool-incapable model
  could legitimately run it; today the gate refuses at entry
  (behavior-preserving v1). Move the check to the fallback boundary for
  `mode: 'oneshot'` jobs. **Effort:** S.


## Skill-bridge (cathedral-7) follow-ups (plan: ~/.claude/plans/system-instruction-you-are-working-witty-fern.md)

- [ ] **P2 — codex/opencode native skills-dir + codex multi-plugin observation
  runs.** **What:** hermetic observation runs (OPENCODE-CLI-PIN.md style)
  answering (a) does codex/opencode read a native skills DIR for direct file
  installs, and (b) does codex's plugin installer handle a multi-entry
  marketplace. On (a) verified: add the dest default to
  `src/core/bootstrap/host-specs.ts` (dated TARGETS note) and lift the
  `--dest`-required refusal in `src/commands/skillpack/harness.ts`. On (b)
  verified: add `gbrain-coding`/`gbrain-daily` entries to
  `.agents/plugins/marketplace.json` (the dist branch already carries the
  variant trees) and flip `test/codex-plugin-manifest.test.ts`'s codex
  marketplace pin from 1 to 3. Recipe anchor: the Grok bootstrap-harness
  checklist below. **Why:** prove-before-publish — the claude lane got a
  real-binary door; these two shipped gated instead. **Effort:** M.
  **Priority:** P2.
- [ ] **P2 — STARTER_OPS question: should get_skill/list_skills join the
  starter surface?** **What:** the stub lane is dead on unmodified plugin
  installs (starter surface hides skills ops; stdio can't persist a
  request_tools widening). Decide whether the starter set grows the two
  read-only skills ops (frozen-surface change: monotonicity test in
  test/mcp-surface.test.ts, publish gate still applies) or stub mode stays
  documented full-surface-only. The contract pin lives in
  test/skillpack-harness-bridge.test.ts (get_skill ∉ STARTER_OPS) and the
  warn text in src/commands/skillpack/harness.ts must move with it. **Why:**
  the biggest single unlock for cold-pull stubs. **Effort:** S (decision) +
  S (change). **Priority:** P2.
- [ ] **P3 — duplicate-skill-name coexistence doctor check.** **What:** a
  doctor probe that detects the same skill name loadable from two lanes at
  once (marketplace plugin snapshot + a bridge install in
  ~/.claude/skills, or two persona variants) and names the lanes. The
  bridge prints a static callout today; #4167 built coexistence detection
  for the MCP server name only. **Effort:** S. **Priority:** P3.
- [ ] **P3 — shared_deps set reconciliation.** **What:** the plugin tree +
  bridge variants ship `_friction-protocol.md` (generator regex) though
  openclaw.plugin.json#shared_deps omits it; RESOLVER.md is referenced by 6
  skills but shipped by neither; _AGENT_README.md is in shared_deps but
  referenced by zero SKILL.md. Pick ONE authoritative set, encode it in
  openclaw.plugin.json#shared_deps, and make the generator + bundle.ts
  consume it. **Effort:** S. **Priority:** P3.
- [ ] **P3 — skill-lint rule for repo-relative shared-dep references.**
  **What:** 20+ SKILL.md bodies reference `skills/conventions/...`
  repo-relatively; those literal paths break in every copied layout (plugin
  tree, variants, bridge installs). Lint them toward sibling-relative
  (`../conventions/...`) which the layouts preserve. **Effort:** S.
  **Priority:** P3.
- [ ] **P3 — removal-era label sweep (filed v0.46.18.0).** **What:** code
  error strings + docs say install/uninstall were "removed in v0.33" while
  the CHANGELOG history records the retirement shipping in v0.36.0.0; pick
  the true version and sweep `src/commands/skillpack.ts`, `harness.ts`,
  `shared.ts`, the guide, KEY_FILES, and `docs/INSTALL.md` together. (The
  other two gaps the post-ship doc review caught — `lens_error` dropped
  from `BridgesStatusEntry`, and reference/remove/scaffold help omitting
  `--scope`/`--workspace`/`--all` — were fixed pre-merge.) **Effort:** S.
  **Priority:** P3.
- [ ] **P3 — unify the three harness-id vocabularies.** **What:** bootstrap's
  `Harness` (src/commands/bootstrap.ts:262, unexported),
  `HarnessSelector` (src/core/bootstrap/harness.ts), and the bridge's
  `BRIDGE_HARNESSES` (src/core/skillpack/harness-bridge.ts) into one core
  registry module (note `HarnessTarget` is taken by the receipt-row type in
  src/core/bootstrap/format.ts). **Why:** three unions drift; a new harness
  should be one edit. **Effort:** M. **Priority:** P3. [CEO-F10]

## Cathedral 5 follow-ups (checkpoint compaction + compiled views)

- [ ] **P2 — `gbrain transcripts checkpoint` manual CLI.** **What:** a thin
  subcommand that runs the checkpoint harvest over an explicit session file
  (tail-read → segment → extract → manifest), direct-engine when no serve is
  running (map LiveServeLockError to a typed skipped status). **Why:** the
  hook + IPC lane covers production; a manual/e2e surface helps debugging and
  non-hook harnesses. **Context:** shipping as a `transcripts` subcommand
  inherits CLI_ONLY + CLI_ONLY_SELF_HELP + SELF_HELP_WITHOUT_ENGINE +
  THIN_CLIENT_REFUSED wiring, the registry entry, and the format flag surface
  for free (cathedral-5 review decision — deferred, not rejected). Start:
  `src/commands/transcripts.ts` + `src/core/context/checkpoint-harvest.ts`.
  Effort: S (CC). Priority: P2.
- [ ] **P2 — opencode transcript adapter + dated SPEC_TARGET.** **What:** an
  opencode session-log adapter in `src/core/transcripts/` (registry entry,
  live-captured fixture, drift alarm) — the prerequisite for ANY opencode
  boundary lane (checkpoint segments, transcripts ingest). **Why:** opencode
  is a full-parity client (v0.46.4.0) with no transcript format; its sessions
  are invisible to the import + checkpoint lanes. **Context:** needs its own
  dated spec verification against a real opencode install before any parser
  lands (cathedral-4 discipline; `OPENCODE_HAS_HOOKS=false` at
  host-specs.ts:365 also blocks the hook lane until verified). Effort: M
  (CC). Priority: P2. Blocked by: access to a live opencode session log.
- [ ] **P3 — compile-context auto-refresh.** **What:** regenerate compiled
  views on the autopilot cycle (or a documented cron recipe) so warm files
  stay living build artifacts instead of manual runs. **Why:** the spec's
  promise is "CLAUDE.md stopped drifting — the fragment is regenerated, not
  hand-edited"; v1 ships the deterministic command only. **Context:** wire
  `runCompileContext` as a cycle phase behind a config gate once the command
  has proven byte-stability in the wild; `--check` is the CI-side staleness
  probe. Start: `src/commands/autopilot.ts` phases + `src/commands/compile-context.ts`.
  Effort: M (CC). Priority: P3.
- [ ] **P3 — thin-client `compile-context`.** **What:** let a thin client
  compile warm files from a REMOTE brain (today the command is
  THIN_CLIENT_REFUSED with a "run on the host install" hint). **Why:**
  remote-brain topologies are exactly the installs that want local compiled
  files with no local DB. **Context:** needs remote read ops for the
  selection arms (list_pages with source scoping exists; salience does not)
  and a stance on scan allowlist location. Cathedral-5 review deferral.
  Effort: M (CC). Priority: P3.
- [ ] **P3 — `asOf`-parameterized, totally-ordered `getRecentSalience`.**
  **What:** add `asOf?: string` to SalienceOpts, replace the SQL `NOW()`
  decay term with the param, and add a slug tie-breaker to the ORDER BY so
  the method becomes deterministic for byte-stable consumers; then restore
  take-signal salience to compile-context selection (v1 dropped it — codex
  round-2 finding: Date.now window + NOW() decay + no total order can
  nondeterministically omit rows at the 100-row cutoff). **Context:** engine
  change + parity work in BOTH engines (`src/core/{pglite,postgres}-engine/salience.ts`,
  `src/core/search/sql-ranking.ts:323`). Effort: M (CC). Priority: P3.
- [ ] **P3 — source-tagged corpus files.** **What:** carry an authenticated
  source id on corpus/segment files so the sweep fallback routes facts to the
  right source instead of the sweep's current source. **Why:** the sweep
  corpus pass ingests every `.txt` in one global dir into ONE sourceId — a
  pre-existing class shared with session-end corpus files (the checkpoint's
  primary IPC lane is already source-correct via boundSourceId). **Context:**
  cathedral-5 codex round-2 finding #5, dispositioned as documented
  limitation + this TODO. Start: `src/core/sweep.ts:466` +
  `src/commands/hook.ts` corpus writers. Effort: M (CC). Priority: P3.


## Fix-wave #4116-#4168 follow-ups (filed 2026-08-16; plan: ~/.claude/plans/system-instruction-you-are-working-compiled-tide.md)

- [ ] **P2 — Expansion reserve()/cap enforcement.** #4121 shipped record-only: expansion spend lands in the tracker (and counts against the ceiling at the NEXT chat reserve) but expand() itself never pre-flights a reserve. A reserve would hard-disable expansion for unpriced local models under any cap (BudgetExhausted reason no_pricing fires whenever a cap is set and the model has no pricing entry). Right shape: reserve only when `isModelPriceable()` (budget-tracker.ts), degrade to `[query]` on denial (the reserve_denied audit row already writes), and apply an output cap (EXPANSION_FAILED_PESSIMISTIC_OUTPUT_TOKENS exists as the accounting constant; passing it to the SDK calls is the behavior change this defers). Files: src/core/ai/gateway.ts, test/core/budget/expand-records-budget.test.ts.

- [ ] **P1 — Legacy Anthropic-direct subagent spend bypasses the tracker entirely.** The DEFAULT subagent path uses the raw Anthropic client (`makeAnthropic().messages`, subagent.ts ~:194; the gateway loop runs only when `agent.use_gateway_loop`), so per-job dollars — which dwarf expansion — never reach withBudgetTracker scopes, despite the A1 ordering comment asserting otherwise. Found while verifying #4121. Fix is its own seam (route the legacy loop's calls through chat() or a record shim), not a fix-wave rider. Files: src/core/minions/handlers/subagent.ts, src/core/ai/gateway.ts.

- [ ] **P3 — models doctor probes chat(), never the real expand() path.** probeModel always calls gateway chat() even for touchpoint 'expansion' (src/commands/models.ts ~:581/:684), so it validates reachability but not the generateObject/generateText branch selection production uses. A real expand() probe needs a distinguishable success signal (expand swallows errors and returns [query]) — assert `result.length > 1` + a new failure classification. Self-contained change.

- [ ] **P2 — racedTimePhase + cycleSignal for the three calibration phases.** propose_takes/grade_takes/calibration_profile run via bare timePhase with no signal (cycle.ts ~:2411-2441; contrast the raced patterns call at ~:2245), so lock-steal/abort cannot interrupt them mid-phase. #4168 fixed the budget half; the abort half widens into signal semantics and deserves its own review. Files: src/core/cycle.ts, src/core/cycle/propose-takes.ts.

- [ ] **P3 — transcript.ts renderBlock still renders v2 gateway blocks as "Unknown block type".** The absorbed #4156 rekeyed the tool ledger to (message_idx, tool_use_id); teaching renderBlock the 'tool-call'/'tool-result' ChatBlock shapes is the remaining half so `gbrain agent logs` shows gateway-path tool use readably. Files: src/core/minions/transcript.ts, test/subagent-transcript.test.ts.

- [ ] **P3 — consolidate the five hand-rolled bounded-wait copies.** Promise.race + setTimeout + clearTimeout now lives in hybrid.ts:151/:898, eval-capture.ts:203, supervisor.ts probeQueueState, telemetry's drain, and pglite-engine's bounded close. A shared `raceBounded(promise, ms)` helper would kill the copy-drift class. Sweep, don't rush — each copy has slightly different timeout/cleanup semantics to preserve. NOTE (#4284): the pglite close copy's semantics are now deliberately divergent and load-bearing — timer armed BEFORE the awaited call starts, deliberately REF'D (no unref), delay clamped to 2^31−1 — and are pinned by structural tests in `test/fix-wave-structural.test.ts`; a sweep must preserve (or parameterize) all three, not normalize them away.
- [ ] **P3 — enable the PGLite disconnect watchdog by default in gbrain's own CI lanes.**
  **What:** set `GBRAIN_PGLITE_CLOSE_WATCHDOG_MS` (~30s) + `..._GRACE_MS` in the serial/e2e
  CI lanes (and consider `scripts/run-serial-tests.sh`) after a soak period, so any future
  #4143-class wedge dies loudly with the `pglite-disconnect-watchdog` stderr label instead
  of eating the lane's full timeout. **Why:** the watchdog is opt-in (a diagnostic
  instrument); today only `tests/heavy/read_latency_under_sync.sh` arms it, and the heavy
  lane runs nightly at best — PR CI wedges would still present as silent timeouts.
  **Context:** shipped with the #4284 fix; the lethal-knob floor
  (`max(5000, sinkCount*2000 + closeTimeout + 2000)`) already protects healthy slow
  teardowns, so the main soak question is worker-spawn overhead per disconnect across
  thousands of test teardowns, and whether any lane has legitimate >30s disconnects.
  **Effort:** S. **Priority:** P3.

- [ ] **P2 — Heavy Tests lane gates nothing on in-repo branches.** #4143 shipped broken for a month because the lane comes back `skipped` on branch pushes and only a downstream fork ran it nightly. Either run a bounded subset (the read_latency workload at reduced params) in PR CI, or make the nightly failure page someone. Files: .github/workflows (heavy lane), tests/heavy/.

- [x] **P3 — conversation-parser eval scorer should fail positive fixtures that report unrecognized_headings.** DONE (test-gap wave): `scoreFixture` now fails a positive fixture whose parse carries a non-empty `unrecognized_headings`, naming the folded labels; the adversarial (pattern-null) fixture class keeps its semantics. Pinned red-first in test/eval-conversation-parser-cli.test.ts; corpus gate stays 24/24.

- [ ] **P3 — file the PGLite close()-deadlock upstream.** Verified: with any statement in flight, `db.close()` AND the in-flight query's promise both never settle (permanent, not slow). No prior report found upstream (searched 2026-08-16). Minimal repro exists in test/pglite-engine-disconnect.serial.test.ts invariant #6; extract into a standalone snippet for electric-sql/pglite.

- [ ] **P2 — doctor check for repeated insufficient_cycle_budget skips.** Post-#4168 a brain whose earlier phases eat the whole job budget skips propose_takes EVERY cycle while cycle_freshness stays green ('partial' accepted) — silent starvation behind a healthy dashboard. Detect N consecutive skip reasons in recent autopilot-cycle results and surface a doctor warn with the raise-interval/anchor hint. Files: src/commands/doctor.ts, src/core/cycle/propose-takes.ts.

- [ ] **P3 — #4136 declined pages consume `--limit` slots on bounded runs.** The decline is deliberately non-terminal (no durable outcome row), so declined pages re-enter every enumeration as claimable and count against `opts.limit` (`processedPagesCount += claimable.length`, extract-conversation-facts.ts) — a bounded manual run over a corpus where declined pages sort ahead can spend its whole limit re-declining the same pages while fresh pages starve. The cycle backfill passes no limit (walltime-bounded), so production is unaffected. Fix: return a per-page declined marker from processPage through the pool result and exclude declines from processedPagesCount, or write a short-TTL outcome row. Found by the ship adversarial pass.

- [ ] **P3 — unclosed code fence suppresses the #4136 folded-heading detector for the rest of the document.** Fence tracking now matches marker TYPE (``` vs ~~~, adversarial fix), but a single unclosed fence — common in truncated LLM output — still disables detection below it (CommonMark-consistent; wrong fail-direction for a detector). Consider bounding fence suppression (e.g. reset at the next recognized speaker anchor). Files: src/core/conversation-parser/parse.ts.

- [ ] **P3 — codex CLI on this machine cannot start while its required MCP server is unreachable.** Every `codex exec` dies after a 30s handshake timeout when the tailnet gbrain MCP endpoint is down; `-c mcp_servers={}` does not bypass. Outside-voice reviews silently lose cross-model coverage (Claude-subagent fallback fires). Make the server optional in codex config, or teach the review preflight to detect-and-warn.
## v0.46.15.0 identity/retrieval wave follow-ups (filed at ship; decisions recorded at CEO review + outside voice)

- [ ] **P2 — Codex adapter full production flip.** v0.46.15 integrated the REAL rollout
  parser (`src/core/transcripts/codex.ts`) for turn selection, but fragment DELIVERY
  remains a harness-shaped contract (no shipped codex injection path exists yet). When
  one lands, flip the seam like the claude-code row (run-scoped infra via
  setupRun/teardownRun; bank the baseline in the same commit). Context: outside-voice F5.
- [ ] **P2 — Per-model calibration for `search.evidence_cosine_floor` (0.80) and
  `search.autocut_min_top` (0.35).** Both are provider-scale-dependent; both are
  config-overridable today. The September reranker default flip (zerank-2 →
  voyage:rerank-2.5) MUST re-tune autocut_min_top — add that line to the v0.47
  removal checklist when executing it. Context: outside-voice F16. Ship-review
  addendum (F6): the floor is not purely a label — `create_safety` consumes the
  evidence tier and gates duplicate-page creation, so a floor that never fires on
  a low-cosine-scale embedder degrades `exists`→`probable` and loosens the
  don't-create-a-duplicate contract. Calibrate BEFORE the September embedder
  default flip, and include a per-model floor table, not one global number.
- [ ] **P2 — Cat 3 undocumented-alias enrichment.** The gbrain-evals Cat 3 runner's
  undocumented class (initials, nicknames, typos) needs alias-TABLE growth
  (enrichment writes page_aliases), not resolver changes — the v0.46.15 alias_exact
  arm only helps documented aliases. Pair with the evals-repo runner repair
  (seed page_aliases + route through resolveEntitySlug). Context: outside-voice F1.
- [ ] **P3 — Lowercase bigram alias candidates.** v2 of the weak-candidate pass
  (`entity-salience.ts`): "sable finch" as a two-token weak alias probe. Unigram
  covers the alias-table convention today; bigram needs its own ambiguity study.
- [ ] **P3 — Precomputed name-token index at ingest.** The surname arm's
  `lower(title) LIKE '% <token>'` scan is bounded by the reflex fail-open budgets;
  if reflex latency telemetry creeps on 10K+-page brains, build the token table
  and swap the arm to an indexed lookup.
- [ ] **P3 — Re-eval community #717 (graph-hop wikilink rerank, claimed +2.6/+2.8
  P@5/R@5) against the post-v0.46.15 ranker** — the concept intent + dedup scope fix
  may have absorbed part of its headroom.
- [x] **P2 — #1663 remainder: query-shape routing, structural exact-lookup
  tier, CRAG confidence escalation.** DONE (v0.46.28.0, #4475): all three
  shipped — `src/core/search/query-intent.ts` (query-shape routing),
  `src/core/search/exact-lookup.ts` (structural exact-lookup tier), and
  `src/core/search/crag.ts` (CRAG escalation seam, config-gated, default off,
  experimental). Issue closed.
- [x] **P3 — Positive underfill-event coverage for searchVector escalation.** DONE
  (test-gap wave) in test/search/searchvector-escalation.test.ts: fire-at-cap
  positive (1120 dense chunks, rungs 100→400→1000, underfilled telemetry —
  covers the second escalation) + the exact-scan lane (real 2100-dim column,
  no HNSW, deep offsets work; the cap keys on the column descriptor). The
  Postgres engine-parity halves stay e2e-deferred. Original filing: The
  two NEGATIVE paths are pinned (no event on genuine short corpus / offset past
  end); the positive fire-at-cap assertion needs a >1000-chunk fixture that pushes
  `innerLimit` to `HNSW_EF_SEARCH_MAX` with the pre-DISTINCT pull full. Pair with
  a >400-chunk second-escalation engine-parity case (both current fixtures stop at
  one escalation). Also cover the exact-scan lane (ship-review): a >2000-dim
  vector column (no HNSW) must keep deep offsets working — the cap now keys on
  `hnswIndexExpected`, pinned only by inspection. From the ship coverage audit
  (C5/T7 partials).
- [ ] **P2 — Reflex IPC version skew: weak candidates against an old `gbrain serve`.**
  An upgraded hook client emits `weak: true` candidates; a not-yet-restarted older
  serve ignores the unknown field and runs lowercase words through ALL arms
  (title/slug-suffix), fabricating pointers during the upgrade window (ship-review
  F4). Options: protocol version tag on ResolveRequest with client-side weak-strip
  when the server doesn't ack; or an upgrade-flow serve restart requirement made
  explicit. Exposure ends at serve restart; kill switch (`GBRAIN_RETRIEVAL_REFLEX_
  LEXICAL_ARMS=false` on the client) also closes it since the client then sends no
  weak candidates.
- [ ] **P3 — Shared wall-clock budget across searchVector escalation attempts.**
  Each escalation retry gets a FRESH 8s statement_timeout on Postgres (worst ~32s
  per vector arm; multiplied under tokenmax multi-query expansion). Share one
  deadline across the loop's attempts (ship-review F8). The loop only fires on
  dense-wall shapes, and per-op timeouts bound the blast radius — hence P3.
- [ ] **P1 — Cat 13 conceptual recall: the concept tilt is NOT enough; the fusion
  itself is the suspect.** Pre-merge receipt (v0.46.15, voyage-4/1024 space, 500
  seeded probes, all adapters on the SAME gateway): bare vector 49.5 nDCG@5,
  grep-only 46.2, vector+grep RRF fusion 40.5, gbrain hybrid 35.6 — and a master
  A/B at the merge-base scored gbrain BYTE-IDENTICAL (35.6, every template), so the
  wave neither regressed nor improved Cat 13. Two honest findings: (a) the
  pre-registered "hybrid ≥ bare vector" target is NOT met — the ±10-20% RRF-k
  concept tilt provably works on a discriminating corpus
  (test/search/concept-weights.test.ts) but is a wash on this probe mix; (b)
  FUSION ITSELF loses to its own best single arm here (40.5 < 46.2 < 49.5) — the
  keyword arm's noise on paraphrase probes drags the merge below either component.
  Next: instrument per-arm rank contributions on the Cat 13 losers
  (synonym 38.7 vs vector 66.4 is the widest), then evaluate arm-confidence-
  weighted fusion (down-weight keyword when its top score is weak) rather than a
  bigger static tilt. Ship with the evals-repo PR (the three uncommitted gateway-
  config patches in gbrain-evals are part of it). Also note: the recorded 47.0-vs-
  49.1 OpenAI-space numbers cannot be reproduced keylessly; the voyage-space gap
  is WIDER — stronger embedders make hybrid's keyword noise relatively costlier.

## LongMemEval temporal gap — date-proximity signal SPIKE-REJECTED (filed v0.46.15.0, identity/retrieval wave)

- **P2 — Reframe the temporal-reasoning gap (94.7% vs MemPal 96.2%, the only categorical
  public-benchmark loss) around what the questions actually are.** The v0.46.15 wave
  pre-registered a spike gate before building a date-proximity ranking term
  (`COALESCE(effective_date, updated_at)` proximity to query-text-extracted since/until
  bounds, per the outside-voice-amended plan). The spike FIRED the stop condition:
  a 12-question sample of the 133 `temporal-reasoning` questions in `longmemeval_s`
  contained ZERO extractable absolute bounds — they are duration-arithmetic
  ("How many days passed between X and Y?", "how many weeks ago did I …") and
  pairwise-ordering ("which happened first …") questions. A scalar date-proximity
  boost fires on none of them; retrieval for these is EVENT-DESCRIPTION recall
  (find the sessions naming the events), and the date math belongs to the answer
  layer — which is what the existing `findTrajectory` routing already does.
  Next honest hypotheses, in order: (a) measure per-question retrieval recall on the
  temporal slice to locate WHERE the 1.5pt is lost (retrieval vs trajectory coverage
  vs answer extraction); (b) if retrieval: event-phrase recall (the event descriptions
  are long noun phrases — expansion/paraphrase territory, adjacent to the v0.46.15
  concept lane); (c) if trajectory: widen `extractCandidateEntities` coverage on
  event-shaped (non-person) anchors. Do NOT rebuild the date-proximity boost without
  new evidence — this entry is the receipt for why it doesn't exist.



## chennai fix-wave follow-ups (filed 2026-08-16)

- [ ] **P1 — read_latency_under_sync hangs from 6a905a1e (#4143); 6a905a1e's
  read-path hunks are the revert candidate.** **What:** phase B of
  `tests/heavy/read_latency_under_sync.sh` never returns; the workload's own
  600s timeout kills it (exit 124). **Investigation so far (chennai wave,
  timeboxed):** reproduced 2/2 on darwin at wave HEAD with default params
  (500/200/4); a stderr-instrumented copy of the SAME workload at the SAME
  params passes cleanly (writers finish by query ~11), and small params
  (50/20/4) pass — the per-iteration stderr writes act as load-bearing yield
  points, consistent with the repo's known Bun timers-phase starvation class
  (cf. GBRAIN_SYNC_YIELD_EVERY: `setTimeout(0)`, NOT `setImmediate` — "Bun
  starves the timers phase under a tight loop"). Suspect surface: #4096's
  hybrid.ts read-path rework (embedQueryBounded's AbortSignal.timeout pairs +
  query-cache/mode changes) turning phase B into a microtask-dominated spin
  that starves timers. Reporter's Linux bisect (100% reproducible, first bad
  6a905a1e) is in #4143. **Next:** either root-cause the starvation (try a
  setTimeout(0) yield in the phase-B loop to confirm the class, then find
  which #4096 await lost its macrotask boundary) or revert 6a905a1e's
  hybrid.ts hunks and re-run the lane. Harness hardening also owed: count
  swallowed query errors (all-fail should not read as latency data), bound
  the `Promise.allSettled(writers)` wait, per #4143's own notes. **Also:**
  the Heavy Tests lane comes back `skipped` on in-repo branches, so this
  gates nothing upstream — fix the lane gating or this class stays invisible.
  **Effort:** M. **Priority:** P1.

- [ ] **P2 — Cache-MODE enum: implicit vs Anthropic-explicit prompt caching.**
  **What:** replace `supports_prompt_cache`'s boolean/predicate with a mode
  (`explicit-anthropic` | `implicit` | `none`) so the gateway's cache-marker
  injection is driven by MODE, not by "caching exists". **Why:** the Google
  predicate fix (#4158) is functionally safe today only because anthropic-
  namespaced providerOptions are ignored on native-google — a transport-level
  pin test (`recipe-google-prompt-cache.test.ts`) guards that; the semantic
  conflation stays until modes exist. **Context:** cross-model review finding
  on PR #4159; the pin test names this TODO. **Effort:** M (CC: S). **P2.**
- [ ] **P2 — Abort-signal threading through BasePhaseOpts + dream generators.**
  **What:** thread an AbortSignal from the job deadline into every calibration
  phase's LLM calls so an in-flight hung request is CANCELLED, not just
  observed at the next loop boundary. **Why:** #4168's clamp restores the
  clean partial-exit but a wedged provider call still burns the reserve.
  **Context:** adjacent to banked PR #4077 (cooperative abort through
  synthesis) — the same seam should serve both. **Effort:** M. **P2.**
- [ ] **P2 — transcripts parser: surface out-of-set speaker headings (#4136).**
  **What:** optional ParseResult field (`suspect_heading_labels` + count) when
  a heading-only anchor-shaped continuation line with an out-of-set label is
  folded under a heading-anchored multi_line pattern; extract-conversation-
  facts warns. **Why:** silent speaker misattribution is accepted parse today.
  **Context:** reporter offered the PR (green-lit in the issue thread with the
  three-label reproducer as tests); keep phase `regex_match`; a decline
  threshold is a follow-on decision. **Effort:** M. **P2.**
- [ ] **P2 — skillopt field-report remainder (#4119, issue closed
  v0.46.28.0/#4475 with these arms still open):** (b) output-size-aware cost
  estimate (preflight.ts fixed 800-token constant); (c) validation-gate
  n-gram overlap detector vs judge definitions; (d) stronger bootstrap
  judges. Shipped in v0.46.28.0: (a) in-rollout-loop runtime deadline
  (`SKILLOPT_RUNTIME_EXCEEDED` in validate-gate.ts), (e) opt-in
  `--hermetic-config` (CLAUDE_CONFIG_DIR) for claude-cli children —
  default-on still needs its own security decision (the provider
  deliberately rides the operator's ~/.claude OAuth session), (f) the docs
  arm (`docs/guides/skillopt.md` hardening notes: rule judges gameable, D13
  prompt-surface-only, cap sizing, human review of proposed.md is
  load-bearing). The guide names (b) and (c) as tracked follow-ups — this
  entry is the tracker. **Effort:** M spread. **P2.**
- [ ] **P3 — orphans.exclude_domains (feature, #4157).** Third exclusion axis
  on the shared orphan policy, matched on the derived domain; must thread the
  orphans denominator query AND both engines' getHealth page-scope rows
  (engine parity). **Effort:** S. **P3.**
- [x] **P3 — dream.synthesize flat/root output_root (feature, #4117).** DONE
  (v0.46.28.0, #4475): `dream.synthesize.output_root` +
  `reflections_slug_prefix`/`originals_slug_prefix` ship as per-lane output
  namespaces (prefixes derived into prompts AND the fail-closed allow-list;
  default preserves wiki/).
- [x] **P2 — test debt from the chennai wave's pre-landing review.** DONE
  (test-gap wave): (a) `/mcp` SDK-transport wiring landed as
  test/e2e/serve-http-source-grant.test.ts (no-grant federated widening vs
  granted confinement over real /mcp, `hasSourceGrant` pinned at the
  provider construction site); (b) getHealth Postgres parity landed as
  test/e2e/health-parity-postgres.test.ts (entity_page_count +
  null-coverage-below-floor + islanded JOIN semantics on both engines);
  (c) REFUTED on verification — within-turn duplicate tool_use_id is
  already covered by test/subagent-tool-ledger.test.ts (the
  same-id/same-message_idx dedup arm), no new test needed.
- [ ] **P2 — adversarial-review residuals on the chennai wave (verified real,
  deferred with rationale).** (a) subagent tool-ledger zero-row settlement
  observability: in the residual zombie race a pending INSERT can be swallowed
  by ON CONFLICT DO NOTHING, the tool still executes, and the settle UPDATE
  then matches 0 rows — the outcome is silently unrecorded and a non-idempotent
  tool can re-execute on replay. Add a rowcount check + job-log warn (needs a
  logging seam in the persist helpers). (b) extract-atoms tombstones cover
  pages only: `recordPageFailureCount` returns null for `kind !== 'page'`, so
  a transcript that deterministically yields malformed output re-spends LLM
  budget every cycle forever — extend #4148's failure-count machinery to
  transcript items. (c) getHealth coverage numerators are not liveness-
  filtered while islanded now is (#4153): a page whose only inbound link is
  from a soft-deleted page counts as covered AND orphaned simultaneously;
  align the coverage EXISTS subqueries with the islanded liveness JOINs in
  both engines (parity + bootstrap-probe update). **Effort:** M spread. **P2.**
- [ ] **P3 — conversation-parser: corpus-level false-positive receipt for the
  multi_line bold-name-date builtin (#4163 follow-on).** Flipping the builtin
  to `multi_line` + score_continuations_as_body means non-conversation prose
  with as few as two `**Name** (date):`-shaped lines can clear the 5% density
  floor (every other line counts as a continuation) and parse as a
  conversation, feeding facts extraction with garbage segments. Build a
  small negative corpus (essays/notes with incidental bold-date lines) and
  either raise the floor for this builtin or require a minimum SPEAKER count.
  Adjacent to the #4136 suspect-heading work above. **Effort:** S. **P3.**
- [ ] **P3 — gateway expand(): record spend for a generateObject call that
  throws after consuming tokens (#4121 follow-on).** The schema-rejection →
  viaText fallback is the double-billed shape; the first call's tokens go
  unrecorded because usage is only read on success. If the SDK error carries
  usage, record it before the fallback retry. **Effort:** S. **P3.**
- [ ] **P3 — eval-contradictions: reject flag-shaped slugs at render time.**
  A slug beginning with `-` renders into `takes supersede '<slug>'` as a
  flag-shaped positional; the pasted command errors rather than executes, but
  a render-time shape check (or `--` separator support in the takes CLI)
  would make the generated command paste-safe for any slug a remote MCP
  writer can mint. **Effort:** S. **P3.**
- [ ] **P3 — DRY refactors flagged by the review army (correct today,
  duplicated shape).** (a) hoist the settlement-status subquery duplicated
  across grade-takes call sites into one helper; (b) extract the three-tier
  resolution (per-call > config > default) repeated in pace-mode/search-mode/
  probe-timeout into a shared `resolveTiered` helper; (c) `renderBlock`-style
  functions taking 6+ positional args → params object; (d) the deadline-skip
  preamble repeated at the top of each cycle phase → shared guard in
  base-phase.ts. **Effort:** S each. **P3.**
## Multi-agent wave follow-ups (cathedral-6, `gbrain agent register`)

- [ ] **P2 — archived sources keep previously-granted federated reads until
  re-registration.** **What:** grants are validated at mint time only — a
  client whose `federated_read` names a source that is archived AFTER
  registration keeps reading it; there is no per-request archived-source
  filtering and no grant invalidation on archive. **How:** this is a
  platform-wide read-path decision affecting every federated op (recall,
  search, entity, boundary verbs), not just recall — either fold an
  `archived = false` join into the shared source-scope resolution or sweep
  grants on `sources archive`; decide once, apply everywhere. **Where:**
  `src/core/ops/context.ts` (sourceScopeOpts consumers), engine read paths,
  `src/core/destructive-guard.ts` (archive lifecycle). **Effort:** M.
  **Priority:** P2.
- [ ] **P2 — federate the remaining read verbs across allowedSources.**
  **What:** `recall` now honors a federated grant (every fact arm fans out
  across `ctx.auth.allowedSources` and merges per-arm — see the `factSources`
  ladder in `src/core/ops/facts.ts` as the pattern), but the rest of the
  frozen-verb read surface stays scalar: `entity` (card assembly) and the
  `context_pack`/`delta` ambient boundary verbs resolve `ctx.sourceId ?? 'default'`
  only. A client granted N sources gets cross-source recall but single-source
  entity cards and boundary packs — the surface splits silently. **How:** route
  each through `sourceScopeOpts(ctx)` and fan out + merge like recall; for the
  perf-clean shape push the source set INTO the engine query instead of
  N round-trips — `findTrajectory`'s `sourceIds` ANY() branch is the
  engine-level filter to mirror. **Where:** `src/core/ops/facts.ts`
  (context_pack/delta), `src/core/verbs.ts` (entity),
  `src/core/context/turn-context.ts`, engine fact/entity list APIs.
  **Effort:** M. **Priority:** P2.
- [ ] **P3 — E5: content-level BrainBench leak detection.** **What:** the
  isolation gate asserts STRUCTURAL leak-absence (every result's source_id is
  inside the caller's grant); a content-level arm would seed known-plaintext
  canary strings into a foreign source and assert no returned text (snippets,
  synthesized answers, graph annotations) contains them — catching join/
  snippet/synthesis leak classes a source_id check can't see. **Where:**
  `evals/brainbench/`. **Effort:** M. **Priority:** P3.
- [ ] **P3 — OpenClaw native remote-MCP register block, when upstream ships
  remote support.** **What:** `gbrain agent register` renders the honest
  thin-client CLI block for openclaw today (`openclawThinClientBlock` in
  `src/core/mcp-registration.ts`) because OpenClaw has no native remote-MCP
  client; when upstream ships one, add a native client-credentials wiring
  block and demote the CLI block to the fallback. Blocked upstream. **Where:**
  `src/core/mcp-registration.ts`, `src/commands/agent-register.ts`.
  **Effort:** S. **Priority:** P3.
- [ ] **P3 — E2: `gbrain agent list` / `gbrain agent revoke` conveniences.**
  **What:** sugar over `gbrain auth clients` / `gbrain auth revoke-client`
  filtered to agent-register-minted clients, with revoke-by-name. Motivation
  is partly retired: `gbrain auth clients` now shows source_id +
  federated_read columns, so the remaining value is the agent-only filter +
  name-based revoke. Build only if operators ask. **Where:**
  `src/commands/agent.ts`. **Effort:** S. **Priority:** P3.



## Security-sweep mitigation follow-ups (filed 2026-08-16)

- [ ] **P1 — `gbrain upgrade` binary lane returns success exit status on failure (autopilot false-success).** **What:** `runUpgrade`'s `binary` case logs every failure reason (`smoke_failed`, `download_failed`, `integrity_failed`, `integrity_unavailable`, `version_mismatch`, `replace_failed`) but never sets a non-zero CLI exit verdict, so callers see exit 0. **Why:** autopilot (`src/commands/autopilot.ts`) can read a false success, record "applied," relaunch, and then mark a transiently-unavailable version permanently bad — an amplification loop, now more reachable because `integrity_unavailable` fires on ordinary GitHub API rate limits. **Context:** PRE-EXISTING for the whole binary lane (not introduced by the v0.46.12.3 integrity work); surfaced by that PR's adversarial review with 2-model consensus. Fix needs care: distinguish hard-fail (`integrity_failed`/`version_mismatch` → exit non-zero, autopilot should NOT mark-bad on a security rejection) from transient (`integrity_unavailable` → retry, not a version fault), with autopilot-loop tests — hence its own PR, not a rushed rider. **Start:** `src/commands/upgrade.ts` binary case + `setCliExitVerdict` + `src/commands/autopilot.ts` upgrade handling.
- [ ] **P3 — Self-update GitHub API rate-limit resilience.** **What:** each `gbrain upgrade` makes 2 unauthenticated `api.github.com` calls (releases/latest + attestations), 60/hr/IP; corporate NAT / CI fleets hit 403 → `integrity_unavailable` → fail-closed. **Why:** a hard availability regression for shared-egress fleets vs the pre-integrity path. **Options:** honor an ambient `GH_TOKEN`/`GITHUB_TOKEN` when present (weigh against widening what a leaked env token authorizes), or a small bounded retry with backoff, and align the attestation fetch timeout (10s) with the download budget so a slow-but-working link doesn't spuriously fail. **Start:** `defaultFetchRelease`/`defaultFetchAttestation` in `src/core/binary-self-update.ts`.


- [ ] **P3 — Integrity for the from-source / `latest-stable` install paths.** **What:** the
  compiled-binary self-update now verifies the GitHub build-provenance attestation before
  installing (`src/core/binary-self-update.ts`), but the primary documented install
  (`bun install -g github:garrytan/gbrain#latest-stable`, a force-moved tag) and the
  force-published `codex-plugin` branch / template repo remain TLS+GitHub trust-on-first-use.
  **Why:** those paths are how most users actually install; a compromised GitHub account could
  serve an unverified tree. **Context:** documented as a residual in SECURITY.md
  ("Install-path trust model"). A postinstall attestation check (or a documented
  `gh attestation verify` step for tag installs) would close it, but a from-source tree has no
  single binary to attest — needs design. **Start:** `scripts/postinstall.ts` +
  SECURITY.md residual note. **Depends on:** the WS2 self-update integrity that just landed.
- [ ] **P3 — Make `check:admin-embedded` deterministic so it can gate.** **What:**
  `scripts/build-admin-embedded.ts` stamps today's date into a comment in
  `src/admin-embedded.ts`, so `check-admin-embedded.sh`'s `git diff --exit-code` fails on any
  day after commit — which is why it's `EXECUTION_EXEMPT` and unwired. **Why:** if the date
  stamp were dropped (or the check ignored it), the embedded-manifest freshness guard could
  actually run in CI. **Context:** correctness guard (catches a forgotten manifest regen), not
  a security control — a backdoored dist regenerates the manifest and passes. The real dist
  trust anchor is build-fresh-in-release (WS1, landed). **Start:** the date-comment line in
  `scripts/build-admin-embedded.ts` + `guards-manifest.tsv:50`.
## CLI→MCP gap-closure wave follow-ups (2026-08-16; plan: ~/.claude/plans/system-instruction-you-are-working-concurrent-lantern.md)

- [ ] **P2 — publish-gate fail-open on a DB-config read failure.**
  **What:** `readPublishGate` + `assertPublishEnabled` (publish-gate path) fall back to the
  file plane when `engine.getConfig` throws, so a DB outage with file-plane=true but a
  DB-override=false widens authorization instead of denying it. **Why:** an auth gate that
  opens wider when its store is unreachable is fail-open — the wrong default for a
  publish/authorization boundary. **Context:** pre-existing behavior, explicitly pinned by
  `test/publish-gates.test.ts:71`; this needs a dedicated auth-plane decision (fail-closed
  vs. the current fail-open), NOT a drive-by flip in a test-regression pass. **Effort:** M,
  review-bound (one-way-door auth semantics).

- [ ] **P2 — takes-fence parser drops pack-extended kinds (whole-page refusal is the interim guard).**
  **What:** `parseTakesFence`'s `KIND_VALUES` is the closed `{fact,take,bet,hunch}` set, so a
  schema-pack kind (`finding|hypothesis|…`) is skipped as malformed and surfaces a warning —
  which is exactly why the F1 guard (`assertFenceRoundTrips`) has to refuse the WHOLE page to
  avoid deleting the skipped row on a re-render. **Why:** a brain with pack-extended takes
  kinds can't be mutated through the write verbs at all today (every mutate refuses
  `fence_unparsed`). **Deeper fix:** widen the parser to accept any string kind (`TakeKind`
  opened to `string` in v0.38) and/or make the fence editor splice-preserve raw unparsed
  lines instead of a whole-fence re-render. **Effort:** M. (Related to the P3 pack-aware
  kind-validation item below, but that one is write-side; this is the parser + editor.)

- [ ] **P2 — `get_health` migration-ledger honesty.**
  **What:** `loadCompletedMigrations` skips a malformed JSONL line with a `warn`, so a
  truncated ledger entry silently mis-reports — a completed migration can look pending —
  instead of surfacing a `ledger_unreadable` signal. **Why:** health/doctor output should
  fail loud when its own audit trail is unreadable, not quietly under-count. **Effort:** S.

- [ ] **P2 — `quarantine_list` SELECT projection pushdown.**
  **What:** the quarantine scan pulls full page bodies (`SELECT p.*`) only to read two
  frontmatter keys. Push the marker filter into SQL (`frontmatter ? 'quarantine'`) and
  project just `slug`, `source_id`, `frontmatter`. **Why:** loading every page body to check
  a frontmatter flag is O(corpus-bytes) for an O(matches) result. **Effort:** S.

- [ ] **P3 — `permissions.takes_write_holders`: split the takes read/write holder axes.**
  **What:** a dedicated write-side holder allow-list config, consumed by the takes write
  verbs' fence in `src/core/ops/takes.ts` (today the WRITE fence reuses the READ
  allow-list `takesHoldersAllowList` — fail-closed and symmetric, but semantically
  overloaded). **Why:** an operator may want an agent to READ private holders but WRITE
  only world-held rows, or vice versa. **Context:** decided at the wave's CEO/OV review
  ("reuse now, split when field use demands"); the fence is one shared function
  (`takesWriteAllowList` + takes-write.ts's holder checks), so the split is a
  resolution-chain change, not a redesign. **Effort:** S. **Depends on:** field demand.

- [ ] **P3 — pack-aware takes kind validation, shared CLI + ops.**
  **What:** `takes_add`/`takes_supersede` pin `kind` to the 4 base literals
  (fact|take|bet|hunch) — same limitation as the CLI's `ensureKind` — while schema packs
  can extend `takes_kinds` (engine.ts TakeKindLiteral). Validate against the ACTIVE
  pack's kind set in ONE shared place (takes-write.ts) and widen the op enum note.
  **Why:** pack-extended kinds (finding|hypothesis|…) can't be written through either
  surface today. **Effort:** S.

- [ ] **P3 — `mcp:capture` provenance channel label (mini trust review).**
  **What:** capture delegates to put_page, so remote captures stamp `source_kind:
  'mcp:put_page'` (honest CV6 delegation; the op result carries channel:'capture').
  A distinct `mcp:capture` stamp needs a trusted internal channel label through the CV6
  else-branch — its own small trust review, filed rather than rushed. **Why:** finer
  provenance analytics on ingestion channels. **Effort:** S, review-bound.

## Five-issue fix wave follow-ups (backlinks corruption / malformed paths / type warnings / getPage scoping / queue admission)

- [ ] **P2 — migrate the remaining fs writers to core/atomic-write.** **What:**
  `src/core/skillopt/apply-edits.ts` (atomicWrite, leaks tmp on write error),
  `src/core/write-through.ts` (own tmp+rename), `src/commands/lint.ts:~526`
  (bare writeFileSync in runLintCore) move onto `src/core/atomic-write.ts`
  (unique tmp + fsync + mode preservation + optional on-disk verify). Include
  page-lock unification: write-through's render does NOT take withPageLock, so
  the backlinks-vs-render lost-update race is only half-closed (backlinks
  locks; render doesn't). **Why:** four hand-rolled copies drift; the shared
  helper is strictly stronger. **Effort:** M. **Priority:** P2.
- [ ] **P3 — relocate/retire skillopt's splitFrontmatter.** **What:** either
  move it to core/markdown.ts next to frontmatterBodyOffset or port its one
  SKILL.md caller onto the canonical helper (skillopt's regex is LF-at-byte-0
  only; the canonical one handles leading blanks + CRLF). **Effort:** S.
  **Priority:** P3.
- [ ] **P3 — admission/stats indexes if hot.** **What:** expression index on
  `(name, (data->>'__param_hash')) WHERE status='waiting'` for the coalesce
  probe + `(name, created_at)` for the per-type stats aggregates, when
  minion_jobs exceeds ~100k rows. Same family as the buildQueueDepths perf
  note (status.ts) and the completed-recency probe TODO below. **Effort:** S.
  **Priority:** P3.
- [ ] **P2 — getPage type-boundary redesign (the durable fix behind the
  guard).** **What:** make source scope explicit at the TYPE level — required
  scope param or an explicit ALL_SOURCES sentinel on `engine.getPage`, so an
  unscoped read is unrepresentable instead of merely linted
  (check-getpage-scoped-write.mjs is the interim guard; the default-first
  ORDER BY makes today's unscoped reads deterministic). ~78 call sites.
  **Effort:** L. **Priority:** P2.
- [ ] **P2 — per-name claim fairness / lane isolation.** **What:** the
  admission wave (coalescing/TTL/quota) is deliberately submit-side only;
  claim order remains global FIFO per queue (`queue.ts` claim ORDER BY), so
  one divergent type still starves same-queue siblings until TTL/quota bites.
  A per-name claim budget or weighted claim is the drain-side primitive.
  **Effort:** L. **Priority:** P2.
- [ ] **P3 — jobs stats divergence: per-queue scoping option.** **What:**
  the DIVERGENT scream computes name-global (matches quota semantics); a
  `--queue`-scoped variant would help multi-queue operators localize the
  producer. **Effort:** S. **Priority:** P3.
- [ ] **P2 — requeue surface for waiting-TTL-cancelled jobs.** **What:**
  `jobs retry` targets failed/dead only; a TTL-cancelled row (error_text
  prefix `waiting_ttl_expired`) that turns out to have been wanted needs a
  `jobs requeue` (or a retry carve-out gated on that prefix) instead of
  hand-resubmitting. The data survives (cancelled rows keep payloads +
  free their idempotency keys), so this is purely a CLI surface. v0.46.25.0
  adds a SECOND machine-readable family to gate on: private-queue reconcile
  cancellations are stamped `private_queue_reconciled: <detail>`
  (PRIVATE_QUEUE_RECONCILE_REASON_PREFIX, minions/queue.ts). A requeue of
  those rows must strip parent/ownership metadata (parent_job_id,
  private_queue_owner_*) and resubmit into a CLAIMABLE queue — never flip
  status in place inside a dead dream-inline-* queue. **Effort:**
  S. **Priority:** P2. (Pre-landing data-migration review, five-issue wave.)
- [ ] **P2 — private-queue FK `ON DELETE SET NULL` erases owner evidence.**
  **What:** purging/pruning an owner job nulls every child's
  `private_queue_owner_job_id` (migrate.ts v136 FK), so its queue silently
  degrades from the fast owner-terminal recovery path to legacy-unowned —
  recovery's scan still sees the lease, but once that expires the queue needs
  manual retriage instead of auto-cancel. Consider stamping a tombstone
  (e.g. keep the id, mark owner_missing) or having prune reconcile the queue
  first. Deferred from the v0.46.25.0 review (behavior change, not coverage).
  **Effort:** M. **Priority:** P2.
- [ ] **P2 — retry-shadow: a same-job-id retry shadows the crashed attempt's
  private queue.** **What:** `jobs retry` reuses the job id; if the prior
  attempt crashed owning a dream-inline queue, the retried (non-terminal)
  owner makes the stale queue classify `live_owner` and recovery skips it
  until the new attempt terminalizes. Options: retry clears/reconciles the
  old private queue on transition, or recovery keys on attempt rather than
  id. Deferred from the v0.46.25.0 review. **Effort:** M. **Priority:** P2.
- [ ] **P3 — v136 `CREATE INDEX` is non-concurrent.** **What:** on a large
  hosted-Postgres `minion_jobs`, migration v136's two partial indexes take a
  write lock for the build. Fine for typical brains; a busy multi-tenant
  install would want `CONCURRENTLY` (which needs the migration runner to
  support non-transactional steps). **Effort:** M. **Priority:** P3.
- [ ] **P3 — full 3-way schema-blob parity test.** **What:**
  `pglite-schema.ts` / `schema-embedded.generated.ts` / `schema.sql` have no general
  drift guard; v0.46.25.0 added a private-queue-scoped parity pin
  (test/private-queue-schema-parity.test.ts) — generalize it to the whole
  blob surface (normalized statement diff). **Effort:** M. **Priority:** P3.
- [ ] **P3 — `jobs work` daemon-level e2e + global stats discovery.**
  **What:** the worker-startup recovery lane is covered at the extracted-
  function level (maybeRunWorkerStartupRecovery); a daemon-level e2e (spawn
  real `gbrain jobs work`, observe recovery, stop it) would close the last
  gap, and `jobs stats` without `--queue` could surface abandoned private
  queues globally (today doctor is the discovery surface). **Effort:** M.
  **Priority:** P3.
- [ ] **P3 — consider ChildWorkerSupervisor.run() catching beforeSpawn
  errors.** **What:** today a rejecting `beforeSpawn` propagates out of
  `run()` with no crash accounting or respawn (documented contract;
  composers must try/catch — MinionSupervisor does). A cross-model review
  dissent argues run() should catch hook errors so one recovery failure can
  never stop a worker silently. Behavior change; needs its own review.
  **Effort:** S. **Priority:** P3.
- [x] **P2 — dream-path quota-degradation integration tests.** DONE
  (test-gap wave): test/minions/dream-quota-degradation.test.ts drives all
  three consumers against a real 1-quota MinionQueue — patterns phase
  `skipped('admission_quota')` with zero child rows, synthesize latch (one
  submit attempt for N transcripts; code truth is N skips, 1 message-form +
  N−1 latch literal — pinned over the TODO's wording), agent fanout
  whole-tree cancel + exit 1 — plus ample-quota admit controls.
- [ ] **P3 — coalesce advisory-lock concurrency e2e.** **What:** real-PG
  e2e slamming N concurrent identical parentless submits → exactly one row
  (the advisory lock serializes (name, queue, hash)); PGLite can't prove
  this (single connection). Home: the DATABASE_URL-gated e2e lane.
  **Effort:** S. **Priority:** P3.
- [ ] **P3 — consolidate the stable-stringify triplets.** **What:**
  `admission.ts` (param hash), plus the two earlier canonical-JSON copies
  (op-checkpoint hashing, cli-options) each roll their own sorted-key
  stringify; one `core/canonical-json.ts` would do. Hash-compat note: the
  admission copy feeds persisted `__param_hash` values — a behavior-change
  regression there just disables old-row coalescing (forward-safe), but
  keep the sorted-key semantics bit-identical anyway. **Effort:** S.
  **Priority:** P3.
- [ ] **P3 — reconcile lane: quarantine-not-delete option for malformed-path
  rows + doctor hint nuance.** **What:** full-sync reconcile hard-deletes
  poisoned rows (consistent with 'strategy' semantics); a
  `--quarantine-malformed` alternative would preserve rows for triage. Also
  the malformed_path_pages doctor hint could distinguish rows whose FILE
  still exists on disk (rename rescues content) from never-committed DB-only
  rows (delete is the only option). **Effort:** S. **Priority:** P3.
- [ ] **P3 — thread source scope into `schema lint --with-db`.** **What:**
  the stored-type data-plane rules accept `LintOpts.sourceId` (multi-source
  brains can resolve different packs per source; comparing another source's
  rows against this manifest yields false alias/undeclared warnings), but
  neither `src/commands/schema.ts` (`runAllLintRules(pack, { engine })`) nor
  MCP `schema_lint` passes it — the CLI runs a global scan. Add
  `--source-id` / honor the worktree pin, and expose `[--json]` in the
  `jobs stats` usage line while in the area (`src/commands/jobs.ts:309`
  documents `--queue`/`--cluster-errors` but not the shipped `--json`).
  Also: the interactive coalesce hint suggests "pass a fresh idempotency
  key", which `gbrain agent run` has no flag for (raw `jobs submit` does).
  Surfaced by the v0.46.11.0 post-ship doc review. **Effort:** S.
  **Priority:** P3.
- [ ] **P3 — one-time cross-source clobber audit.** **What:** the
  pre-guard unscoped-check/scoped-write class could have historically
  written 'default'-source rows that shadow same-slug rows in other sources.
  A one-shot integrity probe (`SELECT slug FROM pages GROUP BY slug HAVING
  count(DISTINCT source_id) > 1` + updated_at ordering heuristics) would
  surface survivors for review. **Effort:** S. **Priority:** P3.

## Containment-sprint follow-ups (coverage truth + module peels; plan: ~/.claude/plans/system-instruction-you-are-working-serialized-forest.md)

- [ ] **P1 — Graduate the diff-coverage gate to blocking (time-boxed 2 weeks from merge).**
  **What:** flip `COVERAGE_GATE_ENFORCE` to `'1'` in test.yml's coverage-report job, add
  coverage-report to test-status's required-success set and cache-write's needs, and replace
  the provisional `scripts/coverage-baseline.json` corpus sections with CI-derived values via
  `scripts/update-coverage-baseline.ts --promote`. **Criteria:** 10 consecutive green
  coverage-report runs on PRs (master runs are structurally cache-skipped — a squash-merged
  tree equals its green PR tree, so the ci-pass marker hits; never count master runs) plus 3
  green nightly fullCorpus merges and zero merge-infrastructure failures. **Why:** the 80%
  diff gate is built and reporting on every PR; blocking is a one-line flip once the
  measurement machinery has receipts. Review `scripts/coverage-gate-exemptions.txt` against
  report-only-window data in the same PR (shrink what gained unit coverage, add only what
  repeatedly false-positives). **Adversarial acceptance items for the same PR:** decide the
  enforce-mode degraded posture (today degraded -> report-only, which post-graduation is a
  bypass channel - fail loud, or require explicit re-run); set a baseline re-seed cadence so
  serial sub-threshold drops (<=0.49pp) cannot compound unboundedly. **Effort:** S. **Priority:** P1.
  **Status (test-gap wave, plan G2):** deliberately NOT flipped — the criteria are a
  wall-clock window (10 green PR runs + 3 nightly fullCorpus merges) that had not
  completed. The flip PR carries the guard test
  (test/scripts/coverage-gate-enforced.test.ts, to be authored in that PR), flips ONLY
  the two PR-lane sites in test.yml (`:481`,`:486`), and leaves e2e.yml's fullCorpus
  occurrence advisory — a separate decision. Criteria stay verbatim; do not loosen.
- [ ] **P2 — Wave 4a: decompose performSyncInner (own plan).** **What:** the 1,923-line
  procedure inside src/commands/sync.ts → sync-phase-{deletes,renames,imports} modules.
  **Why:** the six pure clusters are peeled (sync.ts 5,991→4,121); the remaining bulk is one
  function. **Blocked by:** re-pointing the two positional source-text guards
  (test/sync.test.ts #132 prelude scan, test/redos-hardening.test.ts ordering) at the phase
  modules — needs its own plan. **Effort:** L→M with CC. **Priority:** P2.
- [ ] **P2 — Wave 4b: hoist buildChecks' ~220 inline checks.push literals into named
  functions, then finish the doctor split (own plan).** **What:** doctor.ts is 4,177 lines,
  ~3,240 of them buildChecks. Hoisting the inline literals into named check functions makes
  them movable into the checks/ bundles. **Why:** completes the assessment's #1 named peel
  target. **Effort:** L→M with CC. **Priority:** P2.
- [ ] **P2 — CLI subprocess coverage.** **What:** investigate an in-process CLI-invocation
  harness for a coverage lane (import cli.ts main instead of spawning) and track bun
  child-process coverage support upstream. **Why:** E2E-spawned `bun src/cli.ts` children are
  invisible to bun's coverage (the documented 15.2% cli.ts undercount);
  src/cli.ts sits in the gate exemption list until this closes. **Effort:** M. **Priority:** P2.
- [ ] **P3 — Migrate-runner extraction (revisit only on evidence).** **What:** the ~668
  region-guarded runner lines in src/core/migrate.ts could move to migrate-runner.ts.
  **Why deferred:** 9 slice-window source-text assertions in test/migrate.test.ts pin
  locality; the region-exempt ratchet already forbids logic growth. Revisit if the region
  guard starts failing on legitimate runner work. **Effort:** M. **Priority:** P3.
- [ ] **P3 — Shrink coverage-gate-exemptions.txt as engine unit coverage rises.** **What:**
  the engine files + dirs are exempt because the PR corpus can't see their e2e coverage;
  nightly fullCorpus data shows their true numbers (postgres-engine 40% merged). As narrow-deps
  modules gain unit tests, delist them. **Effort:** S per file. **Priority:** P3.
- [ ] **P3 — Branch coverage when bun ships it.** **What:** bun 1.3.x emits line+function
  lcov only (and JSC omits function names). When branch records (BRDA) land upstream, extend
  merge-lcov.ts and report branch coverage. **Effort:** S. **Priority:** P3.
- [ ] **P2 — Local shard-1 SIGTERM self-kill under load (master-inherited).** **What:** the
  local fast loop's shard 1/4 dies rc=143 with ZERO test failures ~50–85s in when the machine
  carries concurrent bun-test load: an `extract.stale` abort observes SIGTERM and the parent
  bun process dies (`[run-child] job ... not claimed` lines adjacent). Reproduced
  byte-identically on a clean master worktree (`SHARD=1/4 bash scripts/run-unit-shard.sh
  --max-concurrency=2`), so it predates the containment sprint — most plausibly a
  process-group signal escaping a per-job isolation test (#4151 landed the process-isolation
  lane). **Why:** a self-killing shard reads as CI/local flake and poisons full-suite runs.
  **Where to start:** the shard-1 file set's isolation/lifecycle tests
  (test/run-child-entry.test.ts, test/worker-job-isolation.test.ts, test/extract-stale.test.ts)
  — audit for kill(0)/process-group signals under contention. **Effort:** M. **Priority:** P2.
- [ ] **P3 — Evidence-gated engine-core dedup.** **What:** the narrow-deps engine modules
  (facts/takes/code-edges/salience × both engines) are the stepping stone toward a shared
  engine core, NOT the substitute. The prior proposal drew 15 substantive review objections
  (see the earlier module-singleton TODO) — pull this in only when parity maintenance costs
  demonstrably recur. **Effort:** XL→L with CC. **Priority:** P3.
## Codex/Claude plugin lane follow-ups (filed from the plugin packaging wave)

- [ ] **Plugin-lane receipt provenance: re-run bootstrap after plugin install can strand a hand-wired registration.** `appendReceiptRegistration` dedups by (host, scope), so wiring via bootstrap (detail:`mcp`) → enabling the plugin → re-running `bootstrap hooks` overwrites the record with `plugin-mcp`; the plugin-owned uninstall guard then skips `mcp remove` forever, stranding the registration bootstrap itself created. Narrow sequence (plugin enabled AFTER a hand-wired bootstrap). Fix: on the plugin-owned skip, don't downgrade an existing `mcp`-detail record for the same (host,scope), or offer to remove the stale hand-wired entry. Priority: P3. Surfaced by the ship-stage red-team review of the codex-plugin wave.

- [ ] **Windows launcher support.** `.agents/gbrain-launcher` is `/bin/sh` + exec-bit + `command -v` — Unix-only by declaration. A cross-platform launcher (or a Bun-compiled shim) would open the plugin lanes to native Windows. Start: the launcher's header comment + test/codex-plugin-manifest.test.ts behavioral cases. Priority: P3.
- [ ] **Keyless cold-home auto-init (FIRST-LIGHT Act 1).** A plugin user with the binary but no brain gets an actionable "No brain configured. Run: gbrain init" fast-fail from the plugin's MCP server (pinned in the codex plugin door). A `serve --auto-init-pglite` opt-in (or manifest-level flag) could make the first session keyless-magic instead — weigh against the silent-DB-creation consent question. Start: src/cli.ts connectEngine + the plugin manifests' args. Priority: P2.
- [ ] **Additional harness plugin lanes (E6).** The manifest + lockstep-test + coexistence-detector + real-binary-door pattern is established; candidate next lanes: Gemini CLI extensions, Cursor. Start: mirror .codex-plugin/ + the plugin-doors CI job. Priority: P3.
- [ ] **Marketplace upgrade re-resolution probe (EV13 residue).** The slim `codex-plugin` branch is force-advanced per release (release.yml publish-codex-plugin). Whether `codex plugin marketplace upgrade` re-resolves a force-moved branch ref (vs needing remove+re-add) must be verified against the REAL remote after the first release ships, and docs/mcp/CODEX.md's upgrade section adjusted if sticky. Priority: P2 (post-first-release check).
## #4145 lock-renewal wave follow-ups (filed 2026-08-15)

- [ ] **P2 — Kill or reap the force-evicted handler process.** **What:** when the
  grace-evict fires for a handler that ignores its AbortSignal, actually
  terminate the handler's work (LLM loop cancellation vs shell child-tree
  kill differ per handler class) or track it as a zombie instead of only
  freeing the inFlight slot. **Why:** today the evicted handler keeps
  burning CPU/spend on an already-saturated host while the worker claims
  new work — the #4145 amplification loop — and the duplicate-external-
  side-effect window during an asymmetric outage is bounded only by
  handler cooperation, not by `hardEvictMs`. **Context:** deliberately
  scoped out of the #4145 wave (grace-evict at
  `src/core/minions/worker.ts` frees the slot; the alternative — retaining
  the slot until handler exit — re-opens the wedged-slot class D8b closed).
  Eviction frequency collapsed with verify-before-evict, so this is
  hygiene, not the incident driver. Kill semantics need their own review.
  **Effort:** M (human) / S (CC). **Priority:** P2.
- [ ] **P3 — Worker-level `--lock-duration` flag on `jobs work` + supervisor
  passthrough.** **What:** a CLI flag for the worker-global default lease,
  threaded through `buildWorkerArgs` (`src/core/minions/supervisor.ts`).
  **Why:** convenience only — per-job/per-type leases
  (`HANDLER_DEFAULT_LOCK_DURATION_MS`, `--lock-duration-ms`) plus the
  `GBRAIN_LOCK_RENEWAL_*` env knobs already cover every incident-tuning
  case shipped in the #4145 wave. **Context:** requested shape existed in
  the issue; deferred because no production caller overrides
  `lockDuration` and env wins for incident response. **Effort:** S.
  **Priority:** P3.
- [ ] **Note for TODO-LR-2 (doctor `lock_renewal_health`, already filed
  below):** the #4145 wave shipped exactly its inputs — audit events now
  carry `cause`, `lateness_ms`, `overlap_skips`, `load1`/`cores`, `via`,
  `deadline_deferred` — so the doctor check can classify starved-worker
  vs DB-outage windows without new plumbing.
## v0.47 SEPTEMBER REMOVAL — ZeroEntropy (filed v0.46.3.0; TARGET: ship 2026-09-04..2026-09-08)

<!-- 2026-08-29 fix-wave addenda for the removal executor:
  (a) A post-sunset short-circuit now ships ahead of this wave (refs #3657):
      past 2026-09-04 the rerank path skips the dead HTTP call, fails open,
      writes one audit row per process per model (reason sunset_short_circuit)
      and a once-per-process stderr line — so the removal wave inherits a loud,
      latency-free interim state, not a 5s/query hang.
  (b) Default-swap decision input from the issue thread: two independent
      corpus reports found reranking actively HURT (2k-page personal brain —
      three rerankers demoted short entity pages; 19k-page Japanese corpus —
      zerank-2 itself 0/6 vs OFF). A/B the voyage default on a real corpus
      before flipping; "disable in balanced" is a live option. tokenmax must
      leave zerank regardless.
  (c) The autocut_min_top re-tune requirement (outside-voice F16, filed at
      the P2 calibration TODO above) binds to option (a)-style flips only. -->


ZeroEntropy's hosted API dies 2026-09-04. v0.46.3.0 deprecated it (split-default:
new installs → voyage; legacy runtime fallbacks stay ZE; detect-and-notify
migration). The removal wave deletes the provider and performs the hard cutover.
Staged-deletion discipline (ship replacements → migrate call sites → update tests
→ THEN delete; see the skills/_brain-filing-rules precedent below):

- [ ] **P1 — HARD CUTOVER: retire the legacy configless runtime fallbacks.**
  `DEFAULT_EMBEDDING_MODEL`/`DEFAULT_EMBEDDING_DIMENSIONS` (src/core/ai/defaults.ts)
  stop resolving to `zeroentropyai:*`; unmigrated configless brains get a HARD,
  actionable error naming `gbrain migrate embeddings --to voyage:voyage-4 --dim 1024`.
  Also flip `DEFAULT_RERANKER_MODEL` (gateway.ts) + the three mode-bundle
  `reranker_model` values (mode.ts:298,348,403) to `voyage:rerank-2.5` — one-time
  knobs-hash query-cache miss for ALL modes incl. conservative (reranker_model is
  hashed unconditionally; document in that release's CHANGELOG). Verify the schema
  generators' legacy-constant consumers (pglite-schema, postgres-engine,
  embedding-column.ts registry fallback) get a deliberate post-ZE story.
- [ ] **P1 — PREREQ before recipe deletion: move gateway.ts's `'/models/rerank'`
  default path onto explicit per-recipe `path` fields.** llama-server-reranker and
  dashscope-rerank may ride the implicit ZE-shaped fallback — audit + pin with tests
  FIRST or their rerank calls 404 the day the fallback goes.
- [ ] **P1 — Delete the provider surface.** `src/core/ai/recipes/zeroentropyai.ts` +
  registry entries (recipes/index.ts); `zeroEntropyCompatFetch`,
  `MAX_ZEROENTROPY_RESPONSE_BYTES`, `ZeroEntropyResponseTooLargeError` + the
  fetch-ternary arm (gateway.ts); ZE sets in dims.ts; `ze-switch.ts` +
  `retrieval-upgrade-planner.ts` + cli.ts dispatch/CLI_ONLY/CLI_ONLY_SELF_HELP/
  SELF_HELP_WITHOUT_ENGINE/flag-registry rows; `checkZeEmbeddingHealth` in doctor
  (`provider_sunset` STAYS and goes generic — read `recipe.sunset` instead of the
  hardcoded ZE constants); pricing rows LAST (budget-tracker rerank metering reads
  them for historical audit rows). NOTE: test/ai/zeroentropy-compat-fetch.test.ts
  greps gateway.ts SOURCE TEXT — delete the test with the code, in the same commit.
  ALREADY DONE by the interim ZE cleanup wave (pre-Sept): `retrieval-upgrade-prompt.ts`
  deleted (banner/marketing copy gone); `ze-switch.ts` is now a ~170-line pure
  refusal/redirect shim (undo/dry-run ACTIONS retired — apply/undo wrote DB-plane
  config the file-plane-canonical runtime never read); `providers env`/`explain` are
  sunset-aware via the shared `sunsetMarker` in providers.ts (generic on
  `recipe.sunset` — the removal wave inherits it); `ze_embedding_health`'s missing-key
  copy is migration-first (the check itself still gets deleted here).
- [ ] **P1 — Self-host continuity decision.** The v0.46.3 playbook's zero-re-embed
  path keeps the `zeroentropyai:zembed-1` id behind a base-URL override to a
  ZE-wire-compatible endpoint. Recipe deletion breaks it. Decide: keep a minimal
  local-only recipe shell (no picker/auto-pick, no hosted default URL), ship a
  signature-migration tool (rewrite pages.embedding_signature provider ids without
  re-embedding), or explicitly end the promise with a loud migration note. The
  playbook (skills/migrations/v0.46.3.0.md) links here — honor it.
- [ ] **P2 — Tests + CI.** Delete the 8 ZE-dedicated test files
  (zeroentropy-recipe, zeroentropy-compat-fetch, dims-zeroentropy,
  e2e/zeroentropy-live, ze-switch-cli [now pins the shim contract — dies with the
  shim], ze-switch-env-override [pins the planner's test-only functions],
  doctor-ze-checks, provider-sunset-doctor.serial gets REWRITTEN generic not
  deleted) + update ~40 coupled files; drop the zeroentropy-live job +
  ZEROENTROPY_API_KEY secret from .github/workflows/e2e.yml:239,250,377 (line refs
  refreshed by the interim cleanup wave; already date-skip-gated since v0.46.3);
  scripts/test-weights.json rows. Also remove 'ze-switch' from the
  cli-help-without-brain HELP_WITHOUT_BRAIN list when the shim dies.
- [ ] **P2 — Config + docs.** `zeroentropy_api_key` config key: keep
  parseable-but-warned (removing it would make old config.json files fail to
  load); delete docs/ai-providers/zeroentropy.md + its scripts/llms-config.ts
  entry (+ `bun run build:llms`); v0.46.3 migration stays registered and must
  degrade gracefully once the recipe is gone (notice-only — verify its copy).
- [ ] **P2 — Custom-column off-ramp (not removal-gated, but September makes it
  urgent for affected users).** Write-side custom-column migration
  (`gbrain embed --column X --model Y`, embedding-column.ts:60-62 v2 deferral) so
  ZE-backed `embedding_columns` entries get an executable migration instead of
  drop-and-re-embed guidance.
- [ ] **P3 — Optional `cohere-rerank` recipe.** Cohere rerank-4.0-pro is the
  strongest surviving hosted reranker (Agentset ELO 1629, behind only the dying
  zerank-2) for users who want max rerank quality on a dedicated key. Wire shape
  differs from the ZE/voyage dialect — needs its own `top_param`/response mapping
  audit. Filed from the v0.46.3 CEO review (deferred cherry-pick).
- [ ] **P3 — Standalone reranker config-set should purge the query cache.**
  `gbrain config set search.reranker.model ...` (the playbook's manual path)
  changes rank order but leaves cached result sets until the 3600s TTL expires.
  The in-migration path (`migrate embeddings --reranker`) already purges in the
  same transaction — mirror that on the bare config-set path (or fold the
  reranker model into the knobs hash, the same contamination class as
  graph_signals/relational). Filed from the migration-hardening wave review.
- [ ] **P2 — Facts re-embed backfill command.** A dimension transition drops
  `facts.embedding`; facts regenerate only on their next write/`gbrain extract`
  pass. `migrate embeddings --status` + the completion output now report the
  pending census, but there is no command to proactively re-embed the backlog.
  Filed from the migration-hardening wave (outside-voice C5).
- [ ] **P2 — Tier-preserving re-embed.** A bulk stale re-embed (embedding
  migration included) lands per_chunk_synopsis pages at the TITLE context tier
  (embedding-context.ts:211, embed.ts restamp) — a retrieval-quality downgrade
  the migration now REPORTS (plan consent line + completion count) but cannot
  avoid. A tier-preserving mode needs its own LLM-spend consent design (synopsis
  regeneration costs per page). Filed from the migration-hardening wave
  (outside-voice C6).
- [ ] **P3 — `gbrain config set embedding_model` refusal still prescribes
  wipe-and-reinit.** The v0.37.11.0 hard-refuse in `src/commands/config.ts`
  prints `mv brain.pglite` + re-init (PGLite) / "see docs/embedding-migrations.md"
  (Postgres) as the switch recipe. The supported path is now `gbrain migrate
  embeddings --to <provider:model> --dim <N>` on both engines — render this
  surface via `renderCanonicalMigrationCommands` (`src/core/ai/defaults.ts`) and
  add it to `test/canonical-migration-command.test.ts`'s sweep so it can't drift
  again. Filed from the v0.46.9.0 /document-release audit.

## Issues #5+#6 follow-ups (pool starvation + process isolation; plan: ~/.claude/plans/system-instruction-you-are-working-witty-moore.md)

- [ ] **P1-companion — nested-checkout audit + dev-mode detection.** **What:**
  `transaction()` callers that invoke parent-engine methods (or module helpers
  taking `engine` not `tx`) take a SECOND read-pool slot while holding the tx
  slot — e.g. the `operations.ts` advisory-lock loop around `tx.addLink`. Under
  a saturated pool this is a client-side self-deadlock class. Audit call sites;
  add a dev-mode warning (e.g. a tx-depth counter consulted by `runUnsafe`).
  **Why:** the #6 incident's exact 240s-idle sessions were never reproduced
  under a debugger; this is the strongest remaining candidate — the shipped
  wave mitigates the starvation class but does not close this path. **Effort:**
  M. **Priority:** P1-companion.
- [ ] **P2 — per-handler isolation policy.** **What:** a per-handler-name set
  (e.g. long-running LLM-bound handlers isolate, sub-second `lint`/`backlinks`
  stay inline) instead of the all-or-nothing `--job-isolation process`.
  **Why:** spawn cost (~0.3–1s) is noise for 644s subagent jobs, meaningful
  for sub-second handlers; one worker should be able to mix. **Context:**
  `worker.ts` executeJob's `isolated` gate is the seam. **Effort:** M.
  **Priority:** P2.
- [ ] **P2 — per-child --max-rss caps.** **What:** RSS watchdog for isolation
  children (the worker-level watchdog covers the worker only in process mode;
  a startup note ships today). **Context:** child-job-runner.ts owns the child
  lifecycle; a poll of the child's RSS + group-kill on breach mirrors the
  worker watchdog. **Effort:** M. **Priority:** P2.
- [ ] **P2 — jobs-side connection-budget clamp for isolated workers.** **What:**
  warn/clamp concurrency when `concurrency × (child pool + 1) + parent pools`
  exceeds a configured budget (GBRAIN_MAX_CONNECTIONS-style; precedent
  `sync-concurrency.ts:clampWorkersForConnectionBudget`). **Why:** isolation
  multiplies pooler CLIENT connections (~73 at concurrency 15); today the
  budget lives only in docs math. **Effort:** S. **Priority:** P2.
- [ ] **P3 — --job-isolation pass-through for the autopilot's embedded
  supervisor.** **What:** `autopilot.ts` builds its own worker args; add the
  conditional flag there (jobs supervisor already passes through). **Effort:**
  S. **Priority:** P3.
- [ ] **P3 — runLockRenewalTick adoption in the cycle drain.** **What:**
  `synthesize.ts` now uses the minimal `runDrainRenewalTick` (per-call signal +
  guard); adopting the full tick would add the audit channel + bounded
  reconnect. **Effort:** S. **Priority:** P3.
- [ ] **P3 — streaming child progress.** **What:** isolation children report
  progress via their own token-fenced DB writes today (identical to inline);
  an IPC stream would only add parent-side visibility (e.g. lifecycle events
  in `jobs watch`). **Effort:** M. **Priority:** P3.
- [ ] **P3 — connection-audit release events + plain-idle visibility.**
  **What:** `logConnectionEvent` never emits `release`, so the JSONL cannot
  answer "who holds a slot"; and `getIdleBlockers` filters
  `state='idle in transaction'` only — the #6 incident's plain-`idle` sessions
  were invisible to it. **Effort:** M. **Priority:** P3.
- [ ] **P3 — doctor connection_routing check.** **What:** wire
  `ConnectionManager.describeMode()` + `healthCheck()` (both currently
  zero-caller outside tests) into a doctor check naming the routing mode,
  kill-switch state, and per-pool probe latency. Comments in four files
  already reference this check as if it existed. **Effort:** S.
  **Priority:** P3.
- [ ] **P3 — isolation test-gap follow-ups (pre-landing review).** **What:**
  (a) spawned-CLI negative tests for `jobs run-child` bootstrap guards (PGLite
  → exit 13; missing job-id/env → exit 13) and for `jobs work` with
  isolation on + an unresolvable child CLI (fail-fast exit 1) — both need a
  real engine bootstrap so they live in the e2e lane; (b) a behavioral (not
  structural) test driving `withRefreshingLock` with a hung injected
  `handle.refresh` (signal aborted at timeout, no overlapping ticks); (c) a
  force-evict-skip test for isolation mode (needs the 30s evict window made
  injectable); (d) operator-flow message tests (verdict-tailored FATAL text,
  single-pool startup banner). **Why:** the ship coverage audit scored the
  wave 82% — these are the surviving gaps. **Effort:** M. **Priority:** P3.
- [ ] **P3 — raceWithAbortTimeout shared helper.** **What:** the
  "Promise.race a query vs a setTimeout that aborts an AbortController,
  clearTimeout in finally" pattern now exists at five sites (db-probe
  withDeadline, synthesize runDrainRenewalTick, lock-renewal-tick callAbort,
  db-lock tickAbort, supervisor probeAbort), each re-deriving the same
  invariants. Extract one helper and adopt it. **Effort:** S. **Priority:** P3.
- [ ] **P3 — lazy handler resolution in run-child.** **What:** every isolation
  child runs full registerBuiltinHandlers (incl. plugin discovery) to resolve
  ONE handler; the job name is known from the row — a resolve-by-name path
  would skip discovery for builtins. Matters only if isolation is ever used
  for short jobs (documented as not the target). **Effort:** S. **Priority:** P3.
- [ ] **P3 — full checkout instrumentation via a Sql proxy.** **What:** the
  CheckoutGauge covers raw/direct/reserved/tx seams only; tagged-template
  traffic (most engine load) is untracked. A proxy around the postgres.js Sql
  callable could count real checkouts — investigate cost/fragility before
  building. **Why:** would turn the probe's "tracked subset" caveat into full
  coverage. **Effort:** M. **Priority:** P3.

## Security-process follow-ups (filed with Wave −1 of the fix-wave campaign, 2026-08-14)

- [ ] **P2 — Vulnerability disclosure policy.** **What:** a written disclosure
  process: advisory ownership, severity ladder, reporter acknowledgment SLA,
  embargo windows, private patch review, supported-version/backport policy,
  release timing, post-release rotation guidance. **Why:** private vulnerability
  reporting is now enabled (#579) and a reporter has a channel, but a channel
  without a process leaves triage decisions ad-hoc; a public PR diff can still
  broadcast attack surface mid-embargo. **Context:** filed from the fix-wave
  campaign's Codex review (CX-11); the campaign deliberately shipped only the
  toggle + reporter acknowledgment. Start from the responsible-disclosure rules
  already in CLAUDE.md and docs/RELEASING.md. **Effort:** M. **Priority:** P2.
## Code-smell fix-wave deferrals (filed at W0; plan: ~/.claude/plans/system-instruction-you-are-working-encapsulated-eclipse.md)

Each was individually decided as a deferral in the CEO/eng reviews of the
fix-wave plan; the wave series (W0.5–W9, 3.4, 3.6) tracks its own scope there.

- [ ] **Full engine staged merge** (~10 domains onto shared query modules +
  Dialect record). **Priority: P2.** Gated on the W9 two-slice pilot criteria
  (structure+params+results parity on chronicle AND the searchKeyword/CJK
  hard seam; ≥40% domain LOC cut; Dialect ≤~6 fields; query-builder extension
  ≤~150 lines). The terminal fix for the engine-divergence/JSONB class —
  blast radius is the production hot path, hence pilot-gated. Blocked by: W9.
- [ ] **gateway.ts file split** behind a re-export facade (~121 import sites
  unmoved). **Priority: P3.** After W8's behavior changes so the split is
  pure motion; needs the CLAUDE.md engine-dynamic-import exemption-path
  chasers + check-engine-dynamic-import.sh + build:llms.
- [ ] **BrainEngine 149-method interface → domain repos** (65 methods have
  0-1 callers; 3 already deleted in W3). **Priority: P3.** Shape informed by
  the W9 pilot's query-module seam.
- [ ] **Legacy Anthropic-SDK subagent loop deletion.** **Priority: P2.** One
  release after W8 flips `agent.use_gateway_loop` default ON (flag stays as
  the revert path for that release).
- [x] **Deeper test-suite speedup** beyond the W0 snapshot default-on —
  LANDED in the test/eval/CI speedup pass (serial pool 8.5min → ~2.5min,
  snapshot in every CI runner + memoized loader, verify worker pool,
  perf-gate row shrink, chunk-grain engine consolidation). Remaining
  long-tail items are filed in "Test/eval/CI speedup pass deferrals" below.
- [ ] **PGLite schema build-time derivation** from SCHEMA_SQL via a named
  transform list. **Priority: P3.** Only if W3's schema drift TEST proves
  annoying in practice — the test alone kills the drift bug class (Codex
  D4.8/D5.23: fresh-schema equivalence ≠ upgrade correctness; old-shape
  bootstrap fixtures + replay coverage stay regardless).
## Test/eval/CI speedup pass deferrals (filed with the pass; plan: ~/.claude/plans/system-instruction-you-are-working-iterative-hopcroft.md)

Each was explicitly deferred in the pass's CEO/eng/outside-voice reviews.

- [ ] **Sleep-to-poll conversions.** **What:** replace ~49.5s of hard-coded
  `setTimeout` waits with event/poll-based waits; no fake timers exist in the
  suite. Worst offenders: test/minions.test.ts (12.2s across 43 sites),
  test/process-cleanup.test.ts (5.0s), test/worker-lock-renewal-e2e.serial.test.ts
  (4.0s), test/e2e/worker-abort-recovery.test.ts (3.6s), test/e2e/zombie-reaping.test.ts
  (3.3s). **Why deferred:** careful per-site work against flake-hardened timings;
  ~50s ceiling. **Effort:** M. **Priority:** P3.
- [ ] **E2E: PGLite-only parallel lane + default SHARD.** **What:** run-e2e.sh runs
  181 files sequentially (one bun cold start each); ~42 PGLite-only files need no
  Postgres and no TRUNCATE-race protection — run them in a parallel lane; default
  the existing SHARD support (only ci-local uses it). Fold into the Postgres
  template-database entry below in this file (CREATE DATABASE … TEMPLATE, ~50ms).
  **Why deferred:** e2e is off the CI critical path after the workflow restructure;
  ci-local + nightly benefit only. **Effort:** M. **Priority:** P2.
- [ ] **Second PGLite snapshot keyed by dims/model.** **What:** ~34 test files
  configure zembed/1280 and always cold-init (the snapshot's shape gate correctly
  refuses the 1536 fixture). Bake a second snapshot per shape; the version-file
  format already carries dims/model. **Why deferred:** moderate effort, small win,
  and it interacts with the shape gate the memoized loader deliberately keeps hot.
  **Effort:** M. **Priority:** P3.
- [ ] **Persistent-engine snapshot.** **What:** the snapshot fast-path only covers
  in-memory engines (`!dataDir` gate at pglite-engine.ts). ~58 files pass
  database_path and pay full cold init (~121s weighted). Needs tar-extract-into-
  dataDir (or PGlite loadDataDir with a dataDir) design. **Effort:** M. **Priority:** P3.
- [ ] **Engine consolidation audit: doctor/bootstrap/migrations-v0_19_0.** **What:**
  33 files construct 95 engines; chunk-grain-fts was consolidated in-pass, but
  doctor.test.ts (9 engines), bootstrap.test.ts (9), migrations-v0_19_0.test.ts (7)
  need a per-file audit — migration-from-old-schema tests structurally cannot share
  a current-schema engine or use the snapshot. **Effort:** M. **Priority:** P3.
- [ ] **Verify per-check double-spawn removal.** **What:** each CHECKS entry costs a
  `bun run <key>` startup before its bash script; invoking scripts directly from a
  manifest would drop ~47 bun startups. **Why deferred:** micro-win; touches the
  package.json-scripts-as-API convention. **Effort:** S. **Priority:** P3.
- [ ] **Snapshot-tar digest verification (defense-in-depth).** **What:** the CI
  actions/cache for `test/fixtures/pglite-snapshot.tar` validates only the
  schema-hash/dims lines in the sidecar `.version` — which travels in the SAME
  cache entry, so both are forgeable together by anyone with cache write access.
  Record a sha256 of the tar bytes in the version file at build time and have
  `tryLoadSnapshot` verify it (mirror of the gitleaks fetch-fresh-digest
  pattern). **Why deferred:** exploitability bounded by GitHub cache scoping
  (fork caches isolated; poisoning needs push access) and impact is test-DB
  contents only. **Effort:** S. **Priority:** P3.
- [ ] **Redact provider/DB strings in eval ledger writes.** **What:**
  `EvalRunRecord.error` (free text) is persisted unredacted by
  `persistRunRecord` (eval-run-all) and the canary's record mode into the now-
  TRACKED `.gbrain-evals/eval-results.jsonl` — a failed keyed run whose error
  embeds a connection string would ride a later commit into the public repo.
  Route `record.error` + provider-derived params through
  `redactConnectionInfo`/`redactPgUrl` before append; optionally add
  `.gbrain-evals/` to the fixture-privacy scan surface. **Effort:** S.
  **Priority:** P2.
- [ ] **check-image-decoders-embedded.sh into verify CHECKS.** **What:** the guard
  runs its own `bun build --compile` (~60s) — too heavy per-verify. Revisit if the
  binary-embed bug class recurs; guards-manifest.tsv carries the exemption note,
  and the registration⇒execution coverage test allowlists it explicitly.
  **Effort:** S. **Priority:** P3.

## Jobs fix-wave follow-ups (filed v0.45.15.0 — upstream issues #2/#3/#4)

- [ ] **P2 — `jobs submit --max-pending` public flag.** maxPending stays an
  internal submit option this wave (Codex C4): its semantics exclude
  delayed/paused/waiting-children rows, and identity is (name, queue, source)
  so distinct payloads collapse. NOTE (five-issue fix wave): the
  payload-DISTINCT dedupe primitive now exists — admission param-coalescing
  (`coalesce_params` / minions.coalesce_params.<name>, hash of the full
  payload incl. owner lane) covers the "identical submits collapse, distinct
  ones don't" case; --max-pending remains the single-flight-per-scope story.
  Decide the public contract (include delayed? explicit scope key?) after the
  primitive soaks in autopilot, then mirror parseMaxWaitingFlag (clamp
  [1,100]) + help + flag-registry regen + optional submit_job MCP param.
  Where: src/commands/jobs.ts, src/core/operations.ts.
- [ ] **P2 — maxPending at the other single-flight dispatch sites.** The
  freshness sync submit (src/commands/autopilot.ts freshness loop) and the
  targeted remediation steps (autopilot.ts targeted-submit loop) still use
  maxWaiting: 1; widening to maxPending changes behavior of those lanes
  (suppression while a long run is active) and needs its own review. Where:
  src/commands/autopilot.ts.
- [ ] **P2 — Help-stub sweep for the other CLI_ONLY commands.** The `jobs`
  defect class exists elsewhere: `gbrain search modes --help` connects an
  engine before help routing, and the search subcommands have no help guards
  (jobs/bootstrap/skillpack now carry the guard pattern to copy). Audit every
  CLI_ONLY member missing from CLI_ONLY_SELF_HELP; the top-level help promises
  per-command help for all of them. Where: src/cli.ts, src/commands/search.ts.
- [ ] **P3 — jobs stats: fuller backpressure/audit surfacing.** The 24h
  Backpressure line + suppressed-by hint shipped; per-decision breakdowns,
  longer windows, and doctor integration remain (the audit file header's B4
  follow-up). Where: src/commands/jobs.ts, src/core/minions/backpressure-audit.ts.
- [ ] **P3 — jobs watch: timeout/deadline column.** `jobs get` shows the
  effective budget; the live dashboard doesn't. Where: src/commands/jobs-watch.ts.
- [ ] **P3 — jobs help + operator docs: handler catalog and dispatch-event
  schema.** `gbrain jobs --help`'s HANDLER TYPES section lists 8 of the ~40
  registered handlers, and the autopilot dispatch JSON events (`dispatched`,
  `dispatch_coalesced`, `fanout_summary` with its `coalesced` array) have no
  schema documentation outside the CHANGELOG. Where: src/commands/jobs.ts
  (JOBS_HELP), docs/guides/queue-operations-runbook.md.

## Truthful-surface wave follow-ups (filed with T14, amendment 35 + D14.5)

Deferred from the MCP consumer-feedback wave (plan at
`~/.claude/plans/system-instruction-you-are-working-snuggly-parrot.md`; scoped
OUT deliberately — see the plan's "NOT in scope" list).

- [ ] **P1 — strict_params reject-flip.** **What:** flip the `mcp.strict_params`
  default from `warn` to `reject`. **Why:** the warn grace period exists so
  clients adapt before unknown args become hard errors; leaving it warn forever
  re-opens the silent-arg-typo class WP3 closed. **Context:** named flip
  criterion — ZERO `success_with_warnings` rows over 30 days of production
  traffic (`SELECT count(*) FROM mcp_request_log WHERE
  status='success_with_warnings' AND created_at > now() - interval '30 days'`;
  see docs/operations/mcp-surface-runbook.md Move 3). The flip is a config
  DEFAULT change in `resolveStrictParamsMode` + the `additionalProperties:
  false` emission becoming the default tools/list shape; the pinned
  default=warn test to update is `test/validate-params.test.ts` ("unresolved
  (absent) config defaults to warn") and `test/mcp-tool-defs.test.ts` pins
  both emission states. **Effort:** small (1-line default + test updates).
  **Priority:** P1.
- [ ] **P2 — mcp_request_log retention/pruning.** **What:** a retention policy
  (age- or row-capped prune, `gbrain maintain` hook or cron). **Why:** the
  table now carries MORE than request telemetry — `surface_change` audit rows
  (ENG-8) and `denied_after_list` metric rows ride it — and it grows unbounded
  on busy brains. **Context:** pruning must NOT silently discard the audit
  trail — either exempt `operation='surface_change'` or archive before delete;
  the usage reader (src/core/mcp-usage.ts) windows at ≤3650d. **Effort:**
  medium. **Priority:** P2.
- [ ] **P3 — describe_tools op.** **What:** a dedicated per-op schema
  introspection op (design OQ4). **Why:** deferred — `request_tools`' no-arg
  catalog + complete tools/list schemas + did-you-mean on unknown tools/params
  cover the need. **Context:** revisit if a consumer asks for schema detail
  beyond what tools/list carries. **Effort:** small. **Priority:** P3.
- [ ] **P3 — page_lint pull op.** **What:** an op returning the FULL lint
  report for a slug (design OQ5). **Why:** deferred — `put_page`'s inline
  `writer_lint.top_findings` (top 5, errors first) suffices until someone
  needs more than five findings or lint-without-write. **Context:** the
  validator registry + FIX_HINTS (src/core/validators/index.ts) already
  expose everything a pull op would need. **Effort:** small. **Priority:** P3.
- [ ] **P3 — named client tiers.** **What:** Phase 2 of the per-client surface:
  named tiers (e.g. 'analyst', 'writer') stored in the SAME
  `oauth_clients.surface` column. **Why:** teams want role-shaped catalogs,
  not just the 3-step ladder. **Context:** the column's value space is
  documented OPEN (amendment 18) — unknown values fall back to server/config
  resolution with a warn-once, so tier names can land without a migration;
  resolution/UI is the work. **Effort:** medium. **Priority:** P3.
- [ ] **P3 — per-client token budgets.** **What:** Phase 2: per-client
  response token budgets (same column pattern as surface). **Why:** a
  starter-surface client with a 4K-context harness still gets full-size
  payloads; budget belongs to the CLIENT, not the query. **Context:** builds
  on `oauth_clients` per-client columns + the search-mode `tokenBudget` knob;
  interacts with `packToBudget`/`enforceTokenBudget` (keep the frozen-verb
  strictness — ENG-2). **Effort:** medium. **Priority:** P3.
- [ ] **P3 — full list-size telemetry.** **What:** first-class telemetry for
  tools/list responses (per token class: count, approx bytes, trend).
  **Why:** catalog size is the consumer complaint the wave started from;
  today's stopgap only records the count. **Context:** the stopgap
  (amendment 23) rides the existing tools/list `mcp_request_log` row as
  `params.tool_count` — see the runbook's first-5-minutes SQL. A full
  version would bucket bytes and surface in `gbrain search stats`-style
  output. **Effort:** medium. **Priority:** P3.
- [ ] **P3 — get_job invalid_params→not_found alignment (ENG-13).** **What:**
  align admin `get_job`'s unknown-id envelope with `get_agent_job`'s uniform
  `not_found`. **Why:** the two job-read ops answer "no such job" with
  different error codes; `get_agent_job` chose `not_found` deliberately
  (anti-enumeration) and the divergence is recorded, not designed. **Context:**
  ENG-13 kept `get_agent_job` at `not_found` and filed this sibling; check
  callers that branch on `invalid_params` before changing. **Effort:** small.
  **Priority:** P3.

## Truthful-surface wave — pre-landing review deferrals

Filed from the /ship pre-landing review of the wave branch (all classified
review-deferred, not fix-now). Grouped by component.

### MCP transport / serve-http

- [ ] **P2 — memoize the `mcp.default_surface_dcr` read on the tools/call hot
  path.** **What:** a short-TTL (15–30s) memo of the dual-plane
  `resolveDefaultClientSurface` read for NULL-surface clients. **Why:** every
  request from a NULL-surface client pays one serial config RTT today (on
  network Postgres that is real latency); a 15–30s memo makes the hot path
  free while config flips still land within the TTL. **Context:** rescope
  freshness is unaffected — the client ROW surface rides the auth JOIN in
  `verifyAccessToken`, so only the config DEFAULT would be memoized
  (`src/commands/serve-http.ts` resolveEffectiveSurface →
  `src/mcp/surface.ts` resolveDefaultClientSurface). **Effort:** small.
  **Priority:** P2.
- [x] **P2 — extend the Postgres-host e2e with request-log row assertions.**
  DONE (test-gap wave, plan C4+C5): test/e2e/serve-http-oauth.test.ts now
  carries the scope-gate sweep with row-level mcp_request_log twins —
  `denied_after_list`, `success_with_warnings`, and the tools/list
  `tool_count` param — over real HTTP with real OAuth tokens.
- [ ] **P3 — surfaceProjectionDegraded marker for drift-shaped brains.**
  **What:** a visible marker (whoami/_meta/log line) when the surface
  projection is degraded because the schema is drift-shaped: v127 columns
  (`oauth_clients.surface`) present but v85-era prerequisites missing.
  **Why:** on the degrade ladder today an operator surface LOCK silently
  widens to the server ceiling — the operator believes a pin holds when it
  does not. **Context:** only reachable via restored dumps, since migrations
  are ordered; cheap to detect at the existing isUndefinedColumnError seams.
  **Effort:** small. **Priority:** P3.

### Minions / status

- [ ] **P3 — partial index for completed-job recency probes.** **What:**
  `CREATE INDEX ... ON minion_jobs (updated_at) WHERE status='completed'` (or
  fold into the wedge-index family) if `get_status_snapshot` polling becomes
  frequent. **Why:** `buildWorkersSnapshot`'s `max(updated_at)` over completed
  rows seq-scans today; fine at human frequency, wrong under dashboard
  polling. **Context:** same family as the buildQueueDepths perf note in
  `src/commands/status.ts` (partial (queue, created_at) WHERE
  status='waiting' is the sibling fix there). **Effort:** small.
  **Priority:** P3.

### Test infra (master-owned)

- [ ] **P1 — Test-infra pass Ships 2+3: serial burn-down, e2e lane moves + CI
  sharding, weights re-mine.** **What:** the approved test-infra plan
  (`~/.claude/plans/system-instruction-you-are-working-sprightly-bee.md`, Ship 1
  landed as the v0.47.7.0 wave) deliberately split into 3 ships for regression
  attribution. Remaining: Phase 4 serial-lane burn-down (38 rename-safe
  no-marker files + ~75 env-only `withEnv()` conversions — candidate lists with
  per-file justifications were computed and banked in the Ship-1 session;
  recompute mechanically: no `mock.module`, no R1 env mutation, no
  launchTty/process.exitCode/port/timing rationale in the header), Phase 5
  moving the ~52 PGLite-only `test/e2e/` files into the unit matrix (behavioral
  move criterion: direct PGLite ctor + no e2e/helpers import + no
  hasDatabase/DATABASE_URL gate + header read; lockstep: e2e-test-map rows,
  e2e-unmapped-baseline shrink, classify-tests, seeded weights) + 4-way
  `SHARD=N/M` matrix for `selected-e2e`/`coverage-full-e2e` with one postgres
  service per matrix job, and Phase 6 `mine-shard-weights` re-mine (381 files
  unweighted; add a `weights:mine` package script + documented cadence) then
  matrix 10→12. Graduated batch gates: 5×-green first batch per class, 2×+CI
  after. **Why:** the remaining ~half of the measured win: serial lane 220→~130
  files, e2e 60-min worst-case lane → ~15-25 min, honest weights. **Effort:** L
  (spread over 2 ships).
- [ ] **P2 — Phase-2 tail: seven minimal-test targets the v0.47.7.0 wave
  didn't reach.** **What:** same rewrite classes, unattempted: (1)
  `test/destructive-guard.test.ts:39` + (2)
  `test/schema-bootstrap-coverage.test.ts:48` file-level snapshot opt-outs →
  scoped `withColdPglite` (audit which tests genuinely need cold boots — the
  bootstrap.test.ts attempt showed version-rewind arcs DO need them; a
  snapshot-restored engine does not replay migrations after a rewind); (3)
  `test/migrate.test.ts` 14-engine + (4) `test/sync.test.ts` 4-engine
  consolidation to shared beforeAll engines + resets (sync also has 39 git
  execSync sites → `test/helpers/git-fixture.ts`, and a 1100ms sleep →
  `waitFor`); (5) `test/doctor-pglite-scratch-probe.test.ts` route 3 of 4 real
  scratch boots through its own `probeFn` seam (:238-298 proves it); (6)
  `test/apply-migrations-list-db-state` and (7) `test/process-watchdog`
  .test/.serial pair merges where assertions overlap. **Why:** ~15-25s more off
  the unit lane using helpers that now exist (`with-snapshot`, `git-fixture`,
  `wait-for`); several also burn down `scripts/check-test-isolation.allowlist`
  rows. **Effort:** S-M.
- [ ] **P3 — serial-pool-overlaps-parallel-shards.** **What:** run the serial
  pool concurrently with the parallel shards in `run-unit-parallel.sh` instead
  of after the barrier. **Why deferred:** the OOM-rescue verdict pipeline
  assumes shard aggregation ran first (`EXTERNAL_KILL_ANY` gates serial rescue
  eligibility), and both runners independently claim the full memory budget —
  a restructure, not a tweak; post-burn-down the serial tail is small anyway.
- [ ] **P3 — e2e tier2/jsonb-parity decoupling.** **What:** `tier2` waits on
  `jsonb-parity` (the token-spend gate) — up to 15 min of serialization; inline
  a fast pre-flight instead. Preserve the hard-fail-on-missing-DATABASE_URL
  property. **Effort:** S.

- [x] **P1 — test/extract-atoms-chunk-embed.test.ts flakes under parallel
  shards.** DONE (test-infra perf wave): root cause was NOT live-env coupling
  but the gateway singleton's captured env SNAPSHOT — the preload configures
  with `env: {...process.env}`, so a shard-neighbor's provider key (e.g.
  `test/claw-test-cli.test.ts`'s `oai-must-not-leak`) baked into the gateway
  survives the neighbor's own env restore, flips `isAvailable('embedding')`
  true, the atom import fires a real embed inside withBudgetTracker,
  `reserve()` throws BudgetExhausted(no_pricing), and every work item skips →
  status 'warn' / 0 processed (the signature verbatim). Fix: keyless
  `configureGateway({env:{}})` pin in the PGLite describe's beforeAll +
  `resetGateway()` in afterAll + a self-asserting
  `expect(isAvailable('embedding')).toBe(false)` hermeticity pin — same
  pattern as test/ambient-recall.test.ts (which also gained the missing
  `resetGateway()` cleanup in the same change).

### Hygiene dedupe batch (single entry — take together)

- [ ] **P3 — hygiene dedupe batch from the pre-landing review.** **What:**
  eight small same-shape dedupes, cheapest done as one sweep: (1) shared
  `firstSentence` helper (`src/core/operations.ts` firstSentenceOf vs
  `src/mcp/tool-catalog.ts` firstSentence); (2) shared empty-retrieval renderer
  (`src/cli.ts` describeEmptyRetrieval vs `src/mcp/dispatch.ts`
  buildEmptyRetrievalBlock); (3) generic resolveDualPlaneConfig helper for
  the three hand-rolled DB>file>default reads (publish gates,
  strict_params, default_surface_dcr); (4) use `isMcpSurface` at the three
  literal `'verbs'|'starter'|'full'` validation sites; (5) shared `toIso`
  (mcp-usage.ts vs siblings); (6) export the MCP_USAGE window bounds
  ([1, 3650]) from mcp-usage.ts and consume in parseAuthClientsArgs +
  derive-starter-ops instead of re-typing; (7) reuse buildQueueDepths
  (status.ts) in doctor's waitingByQueue + the supervisor probe instead of
  three copies of the same GROUP BY; (8) compose rescopeClient's
  optional-column branch matrix instead of enumerating it. **Why:** each is
  a copy that can drift independently; none is worth its own entry.
  **Context:** all two-way doors, no behavior change intended — land with
  the existing pins green. **Effort:** medium (as a batch). **Priority:** P3.

### Adversarial-review deferrals (cross-model, ship-stage)

Filed from the /ship adversarial review (Codex + Claude synthesis). The twelve
fix-now findings landed on the branch; these four are the review-deferred tail.

- [ ] **P2 — request_tools persist: fold the old-surface read into the atomic
  UPDATE.** **What:** replace the SELECT → UPDATE → audit-write triple with
  one `UPDATE ... RETURNING (SELECT surface FROM oauth_clients WHERE ...)`
  (or capture old via `RETURNING` on a CTE) so the audit row's `old` value
  can never be a stale read from before a concurrent change. **Why:** today
  a rescope racing the persist can make the audit trail record a wrong
  `old→new` transition — the trail answers "why did the surface change" and
  must not lie under concurrency. **Context:**
  `src/core/operations.ts` request_tools persist branch +
  `src/core/surface-audit.ts`; both engines (CTE-in-UPDATE parity check).
  **Effort:** small. **Priority:** P2.
- [ ] **P3 — persist rate-limit durability across restarts/processes.**
  **What:** decide whether the request_tools persist limiter (in-memory
  token bucket, ~5/hr/client) needs DB-backed durability. A server restart
  refills every bucket; a multi-process fleet multiplies the budget by
  process count. **Why:** today the cap is advisory under restart churn —
  fine for the abuse class it targets (runaway clients), wrong if it ever
  guards something stronger. **Context:** `src/mcp/rate-limit.ts` +
  `requestToolsPersistLimiter`; the surface_change audit rows already give
  a DB-side count to enforce against if needed. **Effort:** medium.
  **Priority:** P3.
- [ ] **P3 — document the status --json snapshot union under schema_version.**
  **What:** a short protocol note (docs/progress-events.md sibling) pinning
  the `get_status_snapshot` v2 shape as a discriminated union on
  `schema_version` (v1: no queue/workers keys; v2: sections present but
  per-section fail-soft `{error: 'unavailable'}`), plus a compat table for
  thin-client consumers. **Why:** external `--json` consumers can't rely on
  reading the TypeScript; the fail-soft section shapes are non-obvious.
  **Context:** `src/core/operations.ts` get_status_snapshot,
  `src/commands/status.ts` thin-client sections. **Effort:** small.
  **Priority:** P3.

## Onboarding DX follow-ups (filed v0.45.9.0)

- [ ] **Retire the `config set embedding_model` dead-end across ALL surfaces.** v0.45.9.0 fixed the keyless-init notice to point at `gbrain init --force --pglite --embedding-model <id>`, but `src/core/embed-preflight.ts` (lines ~73/83/90/115) and `src/core/embedding-dim-check.ts:78` still advertise `gbrain config set embedding_model <...>`, which `src/commands/config.ts:142` hard-refuses as a schema-sizing no-op. Same dead-end class, different surfaces. Sweep them to the re-init recipe. Priority: P2.
- [ ] **`gbrain init --supabase` migrate-model dead-end doc.** The Postgres branch of config.ts points at `docs/embedding-migrations.md`; confirm that doc exists and describes a working switch, or write it. Priority: P3.
- [ ] **DX harness binary cache keyed on nothing.** `scripts/dx-explore.ts` reuses `.context/dx-runs/bin/gbrain` unless `--rebuild` is passed, so a second run after code changes can produce transcripts from a stale binary. Key the cache by a source hash (or rebuild when any `src/` file is newer). Dev instrument only. Priority: P3.
- [ ] **`verify` has no MCP-registration check.** v0.45.9.0 made `bootstrap status` report the wire phase `partial` when only hooks landed (host CLI missing), but `bootstrap verify` still exits 0 in that state. Add an MCP-registration probe to verify so the "done when verify exits 0" contract also covers MCP. Priority: P2.
- [ ] **`hasExpansionKey` misses config-plane keys + init-before-key sequencing.** The mode picker reads `process.env` only; a key routed to the 0600 config by the interview (which runs AFTER init) never influences the auto-selected search mode, and the picker never re-fires. Resolve keys through the capability/gateway fold and consider re-running the recommendation when a key is first configured. Priority: P3.
- [ ] **`findEnvKeyTypos` KEY_SHAPE misses no-underscore typos.** `OPENAI_APIKEY` (no `_` before `KEY`) escapes the near-miss net, so that typo class now completes keyless silently instead of failing loud. Widen the regex. Priority: P3.
- [ ] **`init-nudge` stale "4 checks" comment + 6-probe accounting.** The header still says "4 onboard checks" but six probes now run; the partial-checks message counts the page-count probe. Cosmetic. Priority: P3.
- [ ] **FIRST LIGHT (the real first-magical-moment feature).** The v0.45.9.0 tour rewrite is the ship-now slice; the full seed-phase → compendium → scout design is PR-A (seed phase + Mirror + baton) / PR-B (compendium + scout) with one-way-door decisions (new bootstrap phase, consent key, `skills/first-light/`, a one-time Gate-3 narration exemption). Priority: P2.

## Ambient recall follow-ups (filed v0.45.7.0, issue #1)

Deferred from the ambient-recall wave (`context_pack` + `delta` frozen verbs +
boundary runtime; CEO+ENG cleared, plan at
`~/.claude/plans/system-instruction-you-are-working-vectorized-gem.md`). Each was
explicitly scoped OUT with a one-line rationale — none is a bug, all are additive.

- [ ] **Autonomous transcript watchers (D3=B).** The shipped event contract covers session boundaries (start, compaction, heartbeat) but relies on the harness emitting a lifecycle event. A per-harness transcript watcher would drive ambient recall for harnesses that can't emit — but watchers are fragile and compaction is often invisible on disk. Add per harness that proves it can't emit a boundary event. Priority: P3.
- [ ] **Materialized `thread_state` table.** `delta`'s thread-change arm derives open-thread deltas from facts/timeline `updated_at` scans. If a perf gate ever forces it, materialize a `thread_state` table instead of deriving. Not needed until the derive-path SLO is threatened. Priority: P3.
- [ ] **Codex native boundary hooks.** Codex has no PER-TURN/boundary hooks upstream (SessionEnd-only hooks landed with the Memorable wave — `CODEX_HAS_HOOKS=true`, trust-gated via `src/core/bootstrap/codex-hooks.ts`), so its ambient path stays pull-only per turn (AGENTS.md gate tells it to call `context_pack`/`delta` at boundaries). When Codex ships a hook mechanism, register the boundary events the way the Claude Code lane does; the IPC `context_pack` kind + `--harness codex` attribution channel are already reserved for it. Priority: P3.
## Brain-currency harness-e2e follow-ups (filed with the PR-A wave)

- [ ] **P1 — Extend engine-identity convergence to the other long-lived planes.**
  The autopilot daemon now detects a post-migration engine flip
  (`autopilotEngineIdentity` per-tick compare → clean exit for supervisor
  relaunch), but `gbrain serve` (MCP) and a standalone `gbrain jobs work`
  worker hold their engine handle indefinitely and keep writing into the
  abandoned source engine after a flip — the same silent-divergence class,
  still open on those planes (adversarial-review catch). Fix shape: the same
  boot-identity compare in their main loops.
- [ ] **P2 — DB-visible pause for cross-host workers.** The pause marker now
  fences local job pickup (pre-claim check + post-claim release-back in
  `src/core/minions/worker.ts`), but the marker is a local file: a worker on
  ANOTHER host or container pointed at the same Postgres brain never sees it
  and keeps claiming jobs during a migration copy (its in-flight work IS
  visible to the drain via `minion_jobs`/lock rows; new claims are the gap).
  Fix shape: a row in a control table (or a pause flag in `gbrain_cycle_locks`)
  that the claim query itself honors — atomic with claiming, visible
  cluster-wide.
- [ ] **P2 — Route file→symlink typechanges to delete.** `buildSyncManifest`
  maps git status `T` to modified, but import-file deliberately SKIPS symlinks
  (the exfil guard), so replacing an indexed file with a symlink leaves the
  old content indexed forever with no delete. Fix shape: when the post-change
  path is a symlink, emit a delete instead of a modify.
- [ ] **P3 — Surface daemon-internal degradation in status.** A daemon stuck
  in the reconnect-retry loop (crash-classified errors) keeps heartbeating,
  so `--status` reads fresh while zero work happens. Fix shape: a breadcrumb
  file with consecutive-failure count that showStatus reads.

- [ ] **P3 — Extract a shared `seedBrain` test helper.** The keyless-PGLite +
  tmp-HOME + shimmed-PATH setup is duplicated between
  `test/autopilot-launchd-lifecycle.serial.test.ts` and
  `test/agent-scheduler-contract.serial.test.ts` (review-army maintainability
  finding). A third harness-e2e file (the PR-B tier) should force the
  extraction into `test/helpers/`; don't extract before then — two instances
  is a coincidence, three is a pattern.
- [ ] **P3 — Name the quiesce protocol's magic numbers.** `migrate-engine.ts`
  and `autopilot.ts` share three constants by value, not by name: the 600s
  heartbeat-freshness window, the 35s default grace, and the daemon's paused
  fast-poll interval. Hoist into `src/core/autopilot-paths.ts` (the shared
  leaf) as named exports so the two planes can't drift.
- [ ] **P3 — Migration manifest rows don't carry content_hash.** A resume
  trusts `(source_id, slug)` membership in `completed_slugs`; a page edited
  BETWEEN the failed run and the resume is skipped with its stale copy left on
  the target (review-army data-migration finding; pre-existing design, not a
  regression). Fix shape: stamp `content_hash` per completed entry and re-copy
  on mismatch during resume.

- [x] **P2 — Keyless `gbrain dream` contract test.** DONE (test-gap wave):
  test/dream-keyless-exit.test.ts spawns real keyless dreams (allowlist-built
  child env, no provider vars) — exit 0 with status `partial` across json and
  plain spellings; embed is the only structured-fail phase (deriveStatus maps
  it to partial, and dream exits 1 only on `failed`), so the documented cron
  is NOT broken; the sync half still banks a page. Original filing below for
  context. The documented nightly cron
  (INSTALL_FOR_AGENTS.md Step 7) runs `gbrain dream` unconditionally, and the cycle's
  embed phase hits the same `EmbeddingDisabledError` class that broke the documented
  sync-and-embed chain on keyless brains (fixed in `runEmbed` for the `--stale`
  spelling; `test/agent-scheduler-contract.serial.test.ts` pins it). Nobody has verified that a
  full keyless dream exits 0 — if any phase surfaces the disabled-embeddings error as a
  phase failure, the documented nightly cron is broken identically for every
  `init --no-embedding` install. **Where to start:** `src/core/cycle.ts` embed phase +
  `src/commands/dream.ts` exit-code handling; test shape mirrors
  `test/agent-scheduler-contract.serial.test.ts` (keyless PGLite brain, real CLI spawn, exit-code
  assertion). Surfaced by the harness-e2e outside-voice review.

## BrainBench follow-ups (filed v0.44.0.0, Cathedral 2)

Deferred from the BrainBench wave (eng-reviewed; plan + GSTACK REVIEW REPORT at
`~/.claude/plans/system-instruction-you-are-working-bright-firefly.md`).

- [ ] **`--live` agent-in-the-loop know-to-ask.** Replay fixtures with a real model deciding whether to issue retrieval calls; grade the agent, not just the deterministic reflex. Pre-registered in `docs/eval/BRAINBENCH.md` (the v1 metric grades the injection decision, which IS the shipped mechanism). Needs: seeded N-repeat methodology for model stochasticity + budget rails. Priority: P2.
- [ ] **Intrusion-budget gating calibration.** `avg_injected_tokens` is reported, non-gating (decision 18) — a wrong threshold is worse than none. After a few weeks of scoreboard data across PRs, pick calibrated per-seam thresholds and promote it to a gated metric. Priority: P2.
- [x] **Flip contract adapters to production — claude-code half DONE (v0.46.15 identity/retrieval wave).** `adapters/claude-code.ts` now drives the real `gbrain hook user-prompt` path (synthesized Claude Code JSONL transcripts, run-scoped resolve-IPC server with `turn_context` handler, `HookIo` seams) and the scoreboard row is `seam: 'production'`, banked with justification in the same commit. The codex half (real DELIVERY path, not just the parser) is re-filed as the P2 "Codex adapter full production flip" entry in the v0.46.15.0 wave section at the top of this file.
- [ ] **Cathedral 1 conformance-kit fixture import.** The memory-verbs conformance scenarios convert to BrainBench fixtures via the published `evals/brainbench/schema/fixture.schema.json` once `garrytan/cathedral-1` merges ("conformance tests double as BrainBench seed fixtures", decision log 2026-06-12). Free corpus growth from already-reviewed scenarios. Blocked by: cathedral-1 on master. Priority: P2.
- [ ] **Live-embeddings fidelity mode (`--embeddings`).** Hermetic CI grades the keyword/alias arms only (disclosed); an opt-in mode seeding real embeddings would grade write-back/continuity retrieval through the vector path. Same budget rails as `--llm`. Priority: P3.
- [ ] **Community fixture intake + competitor adapters.** The TD1 remainder after the generated corpus absorbed in-PR growth: an `external-authors/`-style intake path for contributed fixtures (validator + privacy guard already gate them) and adapters for non-gbrain memory systems against the published schemas, enabling true head-to-head rows in the gbrain-evals scorecard. Priority: P3.
- [ ] **JSON-Schema ↔ validator parity test.** `evals/brainbench/schema/*.schema.json` is the foreign-runner contract but only existence/parse is pinned — the schemas could drift from `fixtures.ts`'s validator silently. Needs a JSON-schema validator dep (ajv) or a hand-rolled subset checker; deferred to avoid a new dependency mid-wave. Priority: P3.
- [ ] **`eval compare` markdown rendering for `mode: 'n/a'` rows.** EvalRunRecord v3 records brainbench under 'n/a'; the markdown renderer iterates SEARCH_MODES only, so those rows surface in `--json` output but not the mode table (documented in the v3 docstring). Add an un-grouped section to `renderMarkdown`. Priority: P3.
- [ ] **Periodic re-baselining (the ratchet doesn't auto-tighten).** Improvements aren't banked into master's baseline until a PR updates it, so a regression back to a stale baseline level passes. Documented as an accepted residual in `docs/eval/BRAINBENCH.md`; the fix is an operator habit or a scheduled job that re-runs `--update-baseline` after metric-improving merges. Priority: P3.

- [x] **Hermetic-ize the 7 env-sensitive LLM-availability tests.** DONE in
  v0.46.21.0, structurally: `test/helpers/provider-keys-preload.ts` (bunfig
  preload) strips ambient provider keys before any unit-test file loads, so
  dev shells match keyless CI by definition; tests that want keys inject them
  explicitly. Escape hatch `GBRAIN_TEST_KEEP_PROVIDER_KEYS=1` (set by
  scripts/run-e2e.sh).

## sync --working-tree follow-ups (filed v0.43.1.0)

Deferred findings from the v0.43.1.0 ship reviews (adversarial + specialists).
The shipped fix is safe without them; these harden the opt-in further.

- [ ] **P1 — doctor.test.ts subagent_capability test is not hermetic.** `checkSubagentCapability`'s ANTHROPIC_API_KEY drift check reads the real `~/.gbrain/config.json` via `loadConfig()`, so the "ok path" unit test fails on any dev machine with a non-Anthropic chat_model and no ANTHROPIC_API_KEY env (passes in CI). Pre-existing on master (files identical); stub the file-config read in the test or inject it into the check.
- [ ] **P2 — estimator blind spot.** The inline cost estimator prices attached
  working-tree files at $0 by design (#2139 phantom-cost class), so a
  persisted `sync.include_working_tree` + inline embed can spend past
  `sync.cost_gate_min_usd` on a large dirty tree. Price the working-tree
  manifest when the opt-in is resolved true.
- [ ] **P2 — checkpoint/resume vs the workingTree flag.** `op_checkpoint` is
  keyed (sourceId, lastCommit) and records neither the flag nor a working-tree
  fingerprint: a killed `--working-tree` run resumed as a plain sync completes
  commit-only and reports clean `synced` over a mixed snapshot; a working-tree
  path banked pre-kill then edited before resume keeps the stale content.
  Record the flag in the checkpoint key or invalidate on mismatch.
- [ ] **P3 — perpetually-dirty trees vs --ff-only pull.** include_working_tree
  users run dirty trees by definition; any remote change touching a dirty file
  wedges pull → partial/pull_failed until manually resolved. Consider
  auto-stash-pull-pop or a clearer remedy in the pull_failed message.
- [ ] **P3 — drift missing from dry_run/partial results.** `uncommitted` rides
  only up_to_date/synced; dry-run and partial JSON consumers see stderr only.
  The `sync --all --json` per-source envelope also omits it (explicit field
  projection in sync.ts) — add `uncommitted` there when fixing this.
- [ ] **P3 — collapse the two working-tree git subprocesses** into one
  `git status --porcelain=v2 -z` pass (halves per-sync probe overhead), and
  memoize the manifest per (gitContextRoot, headCommit) for `--all` sweeps
  over monorepo-scoped sources.
- [ ] **P4 — warn fatigue.** A perpetually-dirty vault now warns every night;
  consider a dampener (warn on count change, re-warn weekly) so
  blocked_by_failures/pull_failed stay visible.


## #2416 follow-ups (query-steering wave)

- [x] **P2 — MCP-envelope `hint` field for concept-shaped `search` calls.**
  DONE (Truthful Surface Wave, E1): the hint rides `_meta.retrieval.hint` on the
  `search` op (the sibling-metadata-channel option this entry proposed) plus the
  model-visible second content block on empty results. See
  `docs/protocol/MCP_META_CHANNELS.md`.
  **What:** surface the concept→query nudge to remote/MCP agent callers, not
  just the CLI. **Why:** MCP agents are the primary misrouting class the
  #2416 issue describes; the shipped CLI stderr nudge covers the caller class
  *least* at risk. **Context:** the `search` op returns a bare
  `SearchResult[]` (`src/core/operations.ts` — both return sites), so a hint
  needs an envelope change that ripples into `formatResult`, MCP
  serialization, and array-shape tests — deliberately kept out of the atomic
  #2416 commit. The pure classifier already exists
  (`looksConceptShaped`/`conceptNudge` in `src/core/search/query-intent.ts`);
  only the transport is missing. Consider a sibling metadata channel (like
  `_meta.metric_glossary`) rather than changing the array shape.
  **Depends on:** agreeing an envelope pattern that doesn't break existing
  MCP consumers.

## MEMORY_VERBS v1 follow-ups (filed v0.43.0.0 — Cathedral 1)

Deferred from the Cathedral 1 ship (CEO review, EXPANSION mode). Both are
additive to the frozen v1 contract — neither breaks it. See plan + GSTACK
REVIEW REPORT at `~/.claude/plans/system-instruction-you-are-working-agile-iverson.md`
and the scope record at `~/.gstack/projects/garrytan-gbrain/ceo-plans/2026-06-12-memory-verbs-protocol.md`.

- [ ] **P3 — external-implementation certification PROGRAM.** The conformance
  TOOLING shipped (`gbrain protocol conformance --target <endpoint>`); the
  PROGRAM around it (badges, a registry of conformant implementations, listed
  third-party servers) waits for a second implementation to exist. **Why:** the
  protocol-not-product thesis only pays off once someone else implements
  MEMORY_VERBS; until then a certification program certifies an empty set.
  **Where:** new — would build on `src/commands/protocol.ts` conformance output.
- [ ] **P3 — persistent open-threads model for the entity card.** v1 derives
  `entity.open_threads` from active commitment-kind facts + recent timeline
  entries (best-effort, possibly empty). A richer model (a real threads table:
  conversation id, opened/closed state, last activity) would make open-threads
  authoritative. **Why:** the card's open-threads field is the weakest signal
  in v1; a first-class threads store would make it load-bearing. **Where:**
  `src/core/verbs/entity-card.ts` open-threads assembly + a new schema table
  (additive — the card field already exists, so this is a quality upgrade, not
  a contract change).
- [ ] **P2 — `recall` filter composition vs the spec (found by the v0.43.0.0
  cross-model doc review).** The handler dispatch is first-match
  (`supersessions` > `entity` > `session_id` > `since`), so `since` is
  silently ignored when `entity`/`session_id` is supplied, and `limit` has no
  server-side cap. Either compose the filters (additive — the spec's "filters
  the FACTS arm" wording already reads that way) or spell the precedence out
  in `docs/protocol/MEMORY_VERBS_v1.md`. **Where:** the `recall` handler in
  `src/core/operations.ts`.
- [ ] **P3 — widen `synthesize`'s `unavailable` mapping.** Only the
  missing-key gateway warning maps to the `unavailable` error today; other
  no-usable-model failures can surface as `internal` (contract-legal but less
  actionable) or, worst case, a stubbed success. Audit the gateway failure
  modes and map every model-unusable path to `unavailable` with a fix
  suggestion. **Where:** the `synthesize` handler in `src/core/verbs.ts`.
## Fix-wave 1 follow-ups (upgrade-wedge + trust-seam wave, 2026-08)

Deferred from the un-wedge-v121 hotfix wave (eng review + codex outside voice
CLEARED; every item an explicit review decision). Waves 2–6 of the sequence are
planned separately (provider-compat rescue is next; its original 2026-07-24
DeepSeek-deprecation deadline has now PASSED — re-verify each cluster against
master before starting, several fixes landed independently).

- [ ] **P2 — Shared strict `parseFlags` helper as the #2185 end-state (eng
  review 2B).** This wave ships the generated known-flags registry +
  pre-dispatch validator (parser and registry can drift only until the
  freshness guard fires). The structural end-state migrates commands onto one
  shared strict parser so parser == registry by construction; mechanical but
  touches 60+ command files — its own PR. Where: `src/commands/*.ts`,
  `src/cli.ts`, `scripts/generate-flag-registry.ts` (retires).
- [ ] **P2 — `whoknows` CLI routing (surfaced by the #2035-class sweep).**
  `handleCliOnly`'s `whoknows` case (the dedicated CLI renderer with
  thin-client routing) is dead code — the command resolves via the
  `find_experts` op alias, and adding it to CLI_ONLY trips the alias-collision
  guard. Decide the intended surface alongside PR #2509 (whoknows --explain
  per-result factor breakdown) and delete whichever lane loses. Where:
  `src/cli.ts`, `src/commands/whoknows.ts`, PR #2509.
- [x] **P3 — #2544 second half: per-put_page `getAllSlugs` full scan.** DONE
  (v0.46.28.0, #4475): `runAutoLink`'s existence check is now a targeted
  probe instead of hydrating the whole slug set on every put_page. (The
  getChunks egress half had already shipped: explicit non-vector column
  list.) Issue closed.
- [ ] **P3 — #1558 admin-UI register form.** The `/admin/api/register-client`
  API now accepts `source` + `federatedRead` (this wave, PR #2016 absorbed);
  the admin SPA form fields + `/admin/api/sources` picker are the UI layer.
  Where: `src/commands/serve-http.ts` admin SPA blob.
- [ ] **P3 — jsonb-integrity surfaces: batch + share (ship-review follow-up).**
  doctor's jsonbIntegrityCheck runs 2 queries per target (16 round-trips) and
  duplicates the TARGETS table with repair-jsonb (already drifted once on the
  jsonPayloadOnly predicate before being mirrored by hand). Batch the counts
  into one UNION ALL query and extract a shared targets constant
  (src/core/jsonb-integrity-targets.ts) consumed by both. Where:
  `src/commands/doctor.ts` jsonbIntegrityCheck, `src/commands/repair-jsonb.ts`.
- [x] **P3 — register-client HTTP-level e2e (ship-review follow-up).** ABSORBED
  into the cathedral-6 multi-agent e2e suite on `garrytan/cathedral-6`
  (test/e2e/serve-http-multi-agent.test.ts — wire-level register + scoped
  round-trips + invalid source → 400).
- [ ] **P3 — get_chunks `__all__` sentinel narrows to 'default' (red-team,
  Wave 3 territory).** `sourceScopeOpts` returns `{}` for a trusted local
  `--source __all__` caller (documented "spans the brain"), but both engines'
  getChunks map empty scope to the 'default' floor — the one read op where
  `{}` is reinterpreted. Fold into the Wave 3 source-federation cluster's
  `__all__` work (an explicit unscoped signal in the engine signature, or
  handler-side expansion for trusted callers). Where: `src/core/operations.ts`
  get_chunks, both engines' getChunks.
- [ ] **P3 — #2536 wedged-migration diagnostics.** The v121 wedge aborted
  initSchema BEFORE runMigrations, so the wedged-migration diagnostics row was
  never written — operators got a bare SQL error with no remediation hint.
  Write the diagnostics row (or a stderr remediation block) from the blob-replay
  catch path too. Where: `src/core/migrate.ts`, `src/commands/apply-migrations.ts`.
## WAL-repair wave follow-ups (#223/#1670/#2575)

- [ ] **P2 — gate auto-repair on an unclean-shutdown marker (adversarial F7).** The classifier
  deliberately over-matches (`RuntimeError`/`unreachable` → `wasm-abort`). If an unclean
  shutdown leaves a REPLAYABLE WAL tail (normal crash recovery would restore those committed
  txns) and the reopen then fails on a transient WASM error (OOM), auto-repair fires, layout
  validation can't tell torn from replayable, and resetWal discards the tail while the notice
  says "data preserved." Bounded today (backup always taken + restore + honest failure + repeated
  attempts capped), but a false-positive-with-successful-retry silently drops committed data.
  Fix direction (probe-verified): PGLite removes `postmaster.pid` on clean close, so gate AUTO
  repair (not the manual command) on `postmaster.pid` presence — a clean dir that aborts is not
  torn-WAL. Requires making the serial regression test stamp a `postmaster.pid` before corrupting
  (it currently clean-disconnects then corrupts, which the red-team flagged as unfaithful anyway).
  Needs a recall/precision call before landing.
- [ ] **P3 — live non-gbrain PGLite consumer not caught by the postmaster.pid liveness guard
  (adversarial F8).** PGLite writes a sentinel `postmaster.pid` of `-42`; the liveness refusal in
  `validateWalRepairTarget` requires `pid > 0`, so it protects native Postgres dirs but not a
  non-gbrain pglite app that has the dir open (such an app writes no `.gbrain-lock`). Deliberate
  misuse of `pglite-repair --path <foreign pglite dir>` required. Option: refuse when
  postmaster.pid holds pid ≤ 0 with a very recent mtime, or document the boundary.
- [ ] **P3 — mixed-version torn-lock read (adversarial F10 residual).** The heartbeat + initial
  lock writes are atomic (tmp+rename) now, but an OLD gbrain binary writing heartbeats IN PLACE
  while a NEW binary poll-reads can still catch a torn read → corrupt-lock verdict → a live
  holder's lock reaped → two writers (the #2348 class, version-skew-triggered). The reap marker
  quarantines repair, not the concurrent open. Cheap hardening: double-read the lock file (~50ms
  apart) before declaring it corrupt.


- [ ] **P2 — graceful PGLite close on SIGTERM for the remaining long-running paths.**
  The torn-WAL genesis this wave repairs is an unclean shutdown: `src/core/process-cleanup.ts`
  releases locks on SIGTERM but never closes the PGlite handle, so `serve` / `jobs work` /
  `sync` killed mid-write (macOS-upgrade reboot, `systemctl stop`) leave the WAL torn.
  Autopilot already ships the pattern (d2fd1f29, #3178/#1872: `registerCleanup('autopilot-engine-close', ...)`
  — abort in-flight work → ≤2s bounded wait inside the 3s cleanup deadline →
  `engine.disconnect()`, double-call safe; rationale comment at autopilot.ts:438-452).
  Extend that exact pattern to the remaining long-running PGLite paths (register in
  connect()/command scope; dedupe so autopilot doesn't double-close), pinned by a serial
  lifecycle test. Interacts with #2084 exitCode containment + #1337 close ordering — read
  those comments in pglite-engine.ts first. Auto-repair makes recurrence self-healing
  meanwhile, so this is prevention, not recovery.
- [ ] **P3 — pglite upgrade blocker tracker.** Two couplings make a "routine" pglite bump a
  breaking change: (a) pglite ≥0.5 removes the `@electric-sql/pglite/vector` export that
  `pglite-engine.ts` imports (verified against npm); (b) the pg_resetwal port
  (`src/core/pglite-resetwal.ts`) is coupled to the PG17 pg_control layout
  (`PG_CONTROL_VERSION` 1700 — guarded at runtime by `WalResetUnsupportedError`, so a
  mismatched bump makes the repair tool refuse every dir rather than corrupt, but it still
  means the repair feature silently dies). Any future pglite upgrade wave must revisit BOTH
  together and re-derive the ControlFileData offset table for the new PG major.

## synthesize_concepts mints orphans the orphan check then penalizes (filed v0.42.74.0)

The `synthesize_concepts` dream phase writes concept pages that nothing links to,
and the `orphans` phase in the same cycle counts them against the brain score. One
cycle creates the pages, another docks you for them, and the count grows every night
the phase runs. Observed on a real brain: the phase reported N concepts synthesized
and the orphan report listed exactly N orphaned `concepts/` slugs — a 1:1 match, all
of them machine-generated in that run.

This reads to an operator as a curation failure ("I wrote concept pages and never
linked them") when nothing was hand-authored at all. It also makes the brain-score
orphan component drift downward as a direct function of how often the cycle runs,
which inverts the intent of the metric.

- [ ] **P1 — decide whether synthesized concepts belong in the orphan denominator.**
  Two candidate fixes, and they are not equivalent. (a) Wire concepts into the graph
  at synthesis time: when the phase extracts a concept from a set of pages, link those
  pages to the concept node. This is the better outcome — a concept page nothing can
  reach is close to useless for retrieval too, so the orphan signal is telling the
  truth and the synthesis step is what's incomplete. (b) Add `concepts/` to
  `DENY_PREFIXES` in `src/core/orphan-policy.ts`, the way `extracts/` and `atoms/`
  already are. Cheap, but it silences a real reachability problem rather than fixing
  it. Prefer (a); fall back to (b) only if concept nodes are deliberately
  retrieval-only and never meant to be graph-reachable.
- [ ] **P2 — near-duplicate concepts suggest the extractor needs a merge step.**
  The same run produced several near-synonym concept nodes (three variants of one
  adjectival stem, four of one noun stem). Whatever the orphan decision, an extractor
  emitting near-duplicates inflates the node count and splits inbound links across
  synonyms. Consider a similarity merge before write.
- [ ] **P3 — imported calendar days are a separate leaf class.** `meetings/calendar/
  <year>/<date>` pages are dated machine imports with no expected inbound links, the
  same class as the `daily` first-segment exclusion but not matched by it. Either
  broaden the convention defaults or document that calendar-import prefixes want a
  per-brain `orphans.exclude_prefixes` entry.
## serve --http takes-holders + agent-voice hardening follow-ups (filed v0.42.74.0)

Deferred from the #2529/#2477 security-fix wave (plan-eng-review + codex outside
voice CLEARED). None block the wave.

- [ ] **P2 — Per-OAuth-client `takes_holders` storage (#2529 follow-up).** Legacy
  bearer tokens honor `access_tokens.permissions.takes_holders` through
  `verifyAccessToken`; OAuth clients have no equivalent column on `oauth_clients`,
  so OAuth-minted tokens fail closed to `['world']`. Needs a schema migration
  (`oauth_clients.takes_holders` JSONB or TEXT[]) + a `register-client` flag +
  the `verifyAccessToken` JOIN projection. Include surfacing the EFFECTIVE
  takes-holder scope in `whoami` output as part of this follow-up, so operators
  can self-diagnose the legacy-vs-OAuth semantic split instead of reading docs.
  Where: `src/schema.sql`, `src/core/migrate.ts`, `src/core/oauth-provider.ts`,
  `src/commands/auth.ts`, `src/core/operations.ts` (whoami).
- [ ] **P3 — agent-voice Host-header allowlist (DNS-rebinding hardening).** The
  #2477 fix ships default-deny CORS + an Origin gate on `/session`/`/tool`, but
  the gate derives self-origin from the `Host` header, so a DNS-rebound page
  (attacker origin whose host resolves to the operator's loopback) still passes.
  Validate `Host` against `localhost`/`127.0.0.1`/operator-configured hosts and
  403 otherwise; slots beside `originAllowed()` in the router. Issue #2477
  explicitly deferred this. Where: `recipes/agent-voice/code/server.mjs`.
- [ ] **P3 — Debounce `last_used_at` in the oauth-provider legacy path.** The
  legacy branch of `verifyAccessToken` fires an unconditional
  `UPDATE access_tokens SET last_used_at = now()` on EVERY request, while the
  legacy HTTP transport debounces the same write to once per 60s via a WHERE
  clause (`src/mcp/http-transport.ts` validateToken). Apply the same pattern —
  one fewer write per request on the `serve --http` hot path.
  Where: `src/core/oauth-provider.ts`.
## nightly dream digest (filed v0.42.73.1)

Operators wire `gbrain dream --json` into a notifier (Telegram, Slack, email) through a
hand-rolled shell wrapper, then `jq` the counters out of it. That shape is fragile and
produces a low-signal report. Both problems are ours to fix, not the operator's.

- [ ] **P1 — `gbrain dream --digest` — a notification-ready summary gbrain owns.**
  Today every operator re-implements the same `jq` pipeline against `.totals` and
  `.phases[]`. Three failure modes follow. (a) The wrapper guesses at our schema, so a
  field rename degrades it silently. (b) Deltas are impossible — a wrapper has nowhere to
  persist last night's totals, so it can only print levels, and an orphan count carries no
  information without a trend. (c) Wrappers redirect with `2>&1`, which merges our stderr
  progress stream into the `--json` stdout payload and makes the report unparseable; the
  usual `|| echo '?'` fallback then renders a dead monitor as a healthy one. Emit a
  formatted digest directly so none of this is the caller's problem.
- [ ] **P1 — report by exception, with deltas.** A quiet night is `synced=0 extracted=0
  embedded=0` — three zeros in the headline while the `warn` phases and the
  needs-a-human items go unmentioned. Invert it: collapse healthy phases into a single
  status line, lead with `warn`/`error` phases, and render every counter as a delta
  against the prior run. Persist prior-run totals so the delta is real. A phase reporting
  `0 fixes applied` for N consecutive nights while its backlog grows is the signal worth
  paging on, and no level-only report can express it.
- [ ] **P2 — fold `advisor` into the digest's action section.** Every number in a nightly
  report should carry the command that acts on it. `src/core/advisor/` already computes a
  ranked action list from brain state across its collectors; the digest's
  "waiting on you" section should call it rather than grow a second ranking heuristic.
- [ ] **P2 — surface skipped-because-disabled phases.** A dream run can skip many phases
  purely on config flags. That is invisible in the totals, so a brain can quietly do far
  less work than its operator believes for months. Name the disabled phases in the digest.
- [ ] **P3 — document the stdout/stderr contract at the point of use.** `--json` callers
  must not merge streams. Say so in the `dream` help text and in the cron/scheduling
  guide, next to the example wrapper.
## v0.42.67.0 follow-ups (Windows build tooling)

Filed as follow-ups from v0.42.67.0 (`.gitattributes` LF pin for `*.sh` +
`bash` prefix on the 33 `package.json` check commands). Both items are newly
observable: before that release these checks never executed on Windows at all,
so nothing about their runtime was measurable.

- [ ] **P2 — three guard scripts exceed the 120s `run-verify-parallel.sh` cap on Windows.**
  With the dispatch fixed, `bun run verify` on Windows gets 25 passes and 7 failures, and
  `check:privacy`, `check:test-names` and `check:test-isolation` are timeouts rather than
  real failures (they pass on Linux and macOS well inside the cap). They walk the tree with
  per-file shell loops, which is far slower under Windows process creation. Either raise the
  cap for these three, or replace the per-file loop with a single `grep -r` pass. Same cap
  swallows `typecheck`, though standalone `bun run typecheck` exits 0.
- [ ] **P3 — `check:wasm` cannot create its `node_modules` symlink on Windows.**
  `scripts/check-wasm-embedded.sh` fails with `ln: failed to create symbolic link
  '/tmp/gbrain-wasm-check.XXXX/node_modules': No such file or directory`. Unprivileged
  Windows accounts cannot create symlinks without developer mode. Consider a junction, a
  copy, or skipping the check with a clear message when symlink creation is unavailable.

## community fix-wave follow-ups (filed v0.42.60.0)

- [x] **P2 — cherry-pick #2112's uncovered doctor.ts hunk.** Fix-wave A (#2820) superseded
  most of #2112 but not its `checkSubagentCapability` fix (check explicit `models.subagent`
  before `models.tier.subagent`). Implemented: `checkSubagentCapability` now resolves
  `models.subagent` before tier/default fallbacks and has regression coverage.

## v0.42.59.0 follow-ups (five-fix rollup #2735–#2739)

Filed as follow-ups from v0.42.59.0 (bootstrap probe for
`timeline_entries.event_page_id`, migrate-engine source catalog + target-aware
resume, entity-resolution quarantine, escape-aware fence cells, think gather
source scope).

- [ ] **P2 — schema-bootstrap-coverage strip block never exercises `timeline_entries.event_page_id`.**
  The guard's pre-migration-brain simulation (the strip DDL in
  `test/schema-bootstrap-coverage.test.ts`) has no
  `ALTER TABLE timeline_entries DROP COLUMN IF EXISTS event_page_id` (or FK drop), so the
  coverage entry added for the v121 forward reference is vacuous — the probe never fires
  under that harness. The real regression guard lives in `test/bootstrap.test.ts` (which
  does drop → re-bootstrap → assert). Add the DROP statements to the strip block so the
  coverage test genuinely exercises its own entry.
- [ ] **P2 — extract-facts reconcile still wipes-then-reinserts when the parse emitted MALFORMED warnings.**
  `runExtractFacts` (`src/core/cycle/extract-facts.ts`) deletes a page's facts and
  reinserts from the parsed fence even when `parseFactsFence` surfaced
  `FACTS_TABLE_MALFORMED` warnings — any future parse defect becomes a deletion vector
  (rows the parser failed to read get wiped with nothing to reinsert). Consider
  skip-wipe-on-warnings: treat a warning-bearing parse as non-authoritative for that page
  (skip the wipe, surface a warn), mirroring the empty-fence legacy-row guard's posture.
- [ ] **P3 — bare-name resolution quarantines even on an exact unique match when prefix siblings exist.**
  With pages `companies/acme` + `companies/acme-labs`, a bare `"Acme"` yields two
  `findPrefixCandidates` rows, so `tryUnambiguousPrefixExpansion` declines — even though
  `companies/acme` is an exact `dir/token` slug match (and may be a unique exact title
  match). That's an unambiguity signal being wasted. Consider promoting an exact
  `dir/token` (or exact-title) hit above the sibling-count check in
  `src/core/entities/resolve.ts`.
- [ ] **P2 — `scripts/run-verify-parallel.sh` no-gtimeout fallback reports the watchdog's exit code, not the check's.**
  In the fallback branch, `rc=$?` is captured after `wait "$cap_pid"` (the killed
  sleep-watchdog, rc=143) rather than after `wait "$pid"` (the actual check) — on a Mac
  without coreutils every check false-fails with rc=143. Capture `rc` from `wait "$pid"`
  first, then reap the watchdog.
- [ ] **P3 — same-target migrate resume with `--force` still skips checkpointed pages after the wipe.**
  `gbrain migrate --to <engine> --force` wipes the target's pages, but the resume
  manifest's `completed_slugs` filter still applies, so previously-checkpointed pages are
  skipped against the now-empty target (pre-existing behavior; the v0.42.59.0 verification
  warns about it). `--force` should clear the manifest when it matches the same target.
  Where: `src/commands/migrate-engine.ts`.
- [ ] **P2 — think residual scope gaps.** Two spots in `src/core/think/index.ts` don't yet
  inherit the caller's source scope the way the gather stage now does:
  `persistCitations` resolves citation slugs with an unscoped
  `SELECT id FROM pages WHERE slug = $1 LIMIT 1` (cross-source slug ambiguity can attach
  saved evidence to the wrong same-slug page), and the trajectory entity-resolution scalar
  is `opts.sourceId ?? 'default'` (a federated caller with `allowedSources` but no scalar
  resolves entities against `default` instead of its grant). Mirror the gather-stage
  precedence (federated array > scalar > default) at both sites.

## provider-agnostic follow-ups (filed v0.42.58.0)

Deferred from the provider-agnostic plumbing wave (#1249/#1250/#1292/#2271/#2209).
Plan + review trail at `~/.claude/plans/system-instruction-you-are-working-keen-newell.md`.
The eng-review + Codex outside-voice narrowed the wave to these deferrals:

- [x] **P2 — Capability-aware query expansion on OpenAI-compat providers (#2372).**
  Expansion only runs for recipes that declare an `expansion` touchpoint, and only the
  native providers (anthropic/openai/google) do. To make expansion work on
  litellm/openrouter/groq/together/deepseek you must ADD expansion touchpoints to those
  chat-capable recipes AND add a `generateObject`→`generateText` capability fallback for
  backends without strict structured outputs. Feature-shaped; overlaps the general
  OpenAI-compat proxy story (`docs/designs/COMMUNITY_IDEAS.md`). Community PR #2373 is a
  starting point. Implemented by #2373 plus the DeepSeek/Groq/Together recipe wave,
  LiteLLM chat/expansion support, and the OpenRouter expansion touchpoint. Where:
  `src/core/ai/gateway.ts:expand`, recipe files, `types.ts` (ExpansionTouchpoint).
- [x] **P2 — LiteLLM as a chat/expansion backend.** `litellm-proxy` declares ONLY an
  embedding touchpoint, so `think`/chat on LiteLLM is dead. Add chat (and expansion) so a
  LiteLLM proxy is a full LLM backend, not embedding-only. Implemented by #2208.
  The general OpenAI-compat proxy story.
- [ ] **P3 — Per-model embedding dims metadata on `EmbeddingTouchpoint`.** `default_dims`
  is recipe-wide, so a recipe (ollama) can't carry different native dims per model. This
  wave added the modern ollama model NAMES + a `trust_custom_dims` passthrough (user supplies
  `--embedding-dimensions`); per-model dims would let gbrain pick the right default. Then
  ollama could fail-closed at preflight like litellm/llama-server instead of at first embed.
- [ ] **P3 — Google native baseURL normalization (#1250 follow-up).** `resolveNativeBaseUrl`
  covers anthropic + openai; Google was deferred because Gemini's native suffix is unproven
  (its OpenAI-compat route is `/v1beta/openai`). Verify the correct `@ai-sdk/google` suffix,
  then add `google` to the helper. Where: `src/core/ai/gateway.ts:resolveNativeBaseUrl`.
- [ ] **P3 — Fold Google/LiteLLM/OpenRouter API keys into `buildGatewayConfig`.**
  Voyage + Dashscope + Google were folded by #2662 (`build-gateway-config.ts:33-60`);
  remaining gaps are the aggregator keys (litellm, openrouter) whose `config.json`-set
  keys only work if also in `process.env`. Extend the mapping. Where:
  `src/core/ai/build-gateway-config.ts`.
- [ ] **P3 — OpenRouter per-model custom-dim handling.** OpenRouter declares recipe-wide
  `dims_options` and mixes fixed-dim + arbitrary models, so it's excluded from `trust_custom_dims`.
  A per-model story would let OpenRouter accept custom dims for models that support them.
- [ ] **P1 — Gateway subagent-loop tool-result persistence + Date normalization (#2273/#2256).**
  Confirmed crash-block: non-Anthropic subagent jobs dead-letter after any interruption
  (tool-result user turns aren't persisted; raw Date values fail the AI SDK's strict JSON
  check). Larger self-contained change with 6 competing community PRs
  (#2274/#2257/#1934/#2065/#2112/#2336) — pick one canonical impl, preserve authorship.
  This is the immediate fast-follow to the provider-agnostic wave. Where:
  `src/core/ai/gateway.ts:toolLoop`/`toModelMessages`, `src/core/minions/handlers/subagent.ts`.

## Life Chronicle follow-ups (filed v0.42.56.0, #2390)

Deferred from the Life Chronicle wave (CEO Scope-Expansion + eng review CLEARED,
3 codex rounds absorbed, PR #2533). Every item was an explicit review decision,
not an oversight; each names its decision provenance.

- [ ] **P1 — Eval-gated auto-emit default-flip (D5.5 fast-follow).** Auto-emission
  ships OFF (`auto_chronicle=false`) per spend/consent posture. The headline
  fast-follow: run `gbrain eval chronicle` + a live-LLM OFF-vs-ON agent arm on a
  real brain, and if the lift holds, flip the default ON in the next minor with
  an upgrade notice. Where: `src/core/chronicle/config.ts`, upgrade banner in
  `src/commands/upgrade.ts`.
- [ ] **P2 — Live-LLM OFF-vs-ON eval arm + LongMemEval temporal slice.** The
  shipped `gbrain eval chronicle` is the deterministic CI bar (6 gold tasks).
  The full North-Star proof adds (a) a live agent reconstructing a day with the
  chronicle ops ON vs OFF, and (b) the LongMemEval `question_type:
  temporal-reasoning` slice as secondary corroboration — verify the adapter can
  filter by question type first. Where: `src/eval/chronicle/harness.ts`,
  `src/commands/eval-longmemeval.ts`.
- [ ] **P2 — Passive diary capture + consent model (D3.5/E5).** Active-only in v1
  by explicit decision (highest consent-risk surface). Passive detection of
  first-person interiority in transcripts requires a dedicated consent design:
  an explicit `chronicle.diary.passive` opt-in, a consent prompt, and
  provenance-aware redaction (the facts `visibility` lane is already in place).
- [ ] **P2 — Ontology interval-splitting for backdated conflicts (G4).** A
  backdated observation whose validity window overlaps an existing row is
  flagged (not rewritten) in v1. Real interval algebra (split the prior window
  around the backdated fact) is deliberate follow-up scope; the conflict lane
  (`findOntologyConflicts`) is the holding surface. Where: both engines'
  `mergeOntologyFact`.
- [ ] **P3 — Cross-brain federated timeline (D3.6/E6).** v1 holds source
  isolation (scoped-default, `--all-sources` opt-in within the host brain).
  Unifying across mounted team brains is its own epic with an access-policy
  surface.
- [ ] **P3 — Place-as-entity (`gbrain where <venue>`).** `event.where` is
  captured as free text; resolving venues to entity pages + geo-adjacency
  queries is a follow-up.
- [ ] **P3 — Richer meta-ontology dashboard.** `gbrain ontology-dimensions` is
  the v1 surface; a full dashboard (per-dimension drill-down, quarantine review
  queue for novel dimensions) is deferred until usage shows demand.
- [ ] **P3 — Materialized daily timeline pages / emotional-arc view.** The
  query-time aggregator won D5.6; embeddable `life/timeline/YYYY/MM/DD.md`
  narrative pages (a single `materialize_timeline` cycle phase) revisit after
  the eval shows `reflect`-style recall needs them.

## reliability fix-wave follow-ups (filed v0.42.52.0)

Deferred from the autopilot/supervisor + sync/status/minion reliability wave
(plan-eng-review + codex + adversarial diff review CLEARED). Both surfaced by the
ship-stage pre-landing review; neither blocks the wave.

- [ ] **P2 — Thread a cancellation signal through `importFile` (#1950).** The sync
  stall watchdog aborts `opts.signal`, but the per-iteration abort checks observe
  it BETWEEN files — a hang inside one `importFile` call (e.g. a stuck embed
  network request) isn't interrupted until that call returns. Thread an
  `AbortSignal` into `importFromContent`/`importFromFile` and check it at the async
  phase boundaries (post-parse, pre-embed, pre-DB-write) so an in-flight wedge is
  reaped too. Core hot path (engine-parity + downstream-client surface) — scope it
  on its own. Where: `src/core/import-file.ts`, `src/commands/sync.ts`.
- [ ] **P3 — Centralize live-sync liveness onto `liveSyncStatus` (#1950).**
  `gbrain sources status` now uses the shared `liveSyncStatus(engine, sourceId)`
  helper; retrofit `gbrain doctor` (its own inline lock probe) and `gbrain status`
  onto the same helper so there's one source of truth for "is this source
  syncing." Where: `src/core/db-lock.ts`, `src/commands/doctor.ts`,
  `src/commands/status.ts`.

## Pace Mode follow-ups (filed v0.42.49.0)

Deferred from the paced-backfill wave (CEO + eng review CLEARED). Core shipped:
`db-pacer` + `pace-mode` wired into embed (CLI + shared core + `embed-backfill`
job) and sync. See CLAUDE.md "Pace Mode".

- [ ] **P2 — `doctor` pacing check (E2).** Detect a txn-mode pooler (port 6543)
  running unpaced bulk and recommend `--pace`; optionally correlate recent
  `minion_jobs` deaths with backfill windows. Where: `src/commands/doctor.ts`.
- [ ] **P2 — `--pace=auto` autotuned thresholds (E3).** Derive `paceAtMs`/cap from
  observed baseline latency (rolling median) instead of fixed bundle values,
  mirroring `gbrain search tune`. Needs a baseline window + cold-start default +
  config persistence — not a small add. Where: `src/core/pace-mode.ts` +
  `src/core/db-pacer.ts`.
- [ ] **P3 — First-class pacing in more minion job handlers (E5).** `embed-backfill`
  is paced; extend to `extract`/`embed-catch-up`/contextual-reindex handlers with
  supervisor-detection downgrade. Today these inherit config/env pacing only when
  they call `runEmbedCore`.
- [ ] **P1-companion — Supervisor concurrency 3→2 + job-kind slot fairness (E7).**
  **v0.45.15.0 annotation (jobs fix wave):** make the whole wedge-detector FAMILY
  suppression-aware while here — the supervisor watchdog (supervisor.ts wedge
  predicate) and doctor's `wedged_queue` check both require waiting > 0, and
  `maxPending` single-flight keeps waiting at 0 while a job is in flight.
  Mitigations already shipped: maxPending counts only LIVE-LOCK actives (a
  dead/blocked worker's expired-lock row never suppresses, so fresh waiting rows
  re-feed the detectors) and `jobs stats` prints a Backpressure line + a
  suppressed-by hint. Remaining: teach watchdog/doctor to treat
  recent-coalesces + stale live active as wedge signal; also note the worker
  in-flight stall-check hole (worker.ts stall check skips when inFlight > 0).
  The daemon-side root cause the external wrapper's probe was blind to:
  `embed-backfill`/`autopilot-cycle` jobs can occupy all supervisor slots
  (`:215` below). Pacing makes backfills safe; this fixes the residual death rate.
  Where: `src/core/minions/supervisor.ts` + queue slot accounting.
- [ ] **P3 — `gbrain sync --pace` CLI flag.** Sync reads env/config pacing today;
  add a per-run `--pace[=mode]` flag for symmetry with `embed`. Where:
  `src/commands/sync.ts` arg parsing.
- [ ] **P3 — Real-PG e2e for pacing.** Gated on `DATABASE_URL`: paced
  `embed --stale --pace --progress-json` caps concurrency + emits telemetry;
  single-flight rejects a 2nd concurrent run; lock heartbeat advances during a
  paced sleep (short-TTL). Unit coverage (`db-pacer`/`pace-mode`) already ships.
## monthly backup-check follow-ups (filed with the backup-coverage feature)

- [ ] **P2 — Opt-in network push-probe for the backup check (`gbrain backup check --probe`).**
  **What:** authed `pushProbe` (`src/core/git-remote.ts:598`) per asset proving the remote
  is actually PUSHABLE, with TTL-cached verdicts (the `repo-visibility.ts` 1h-cache idiom).
  **Why:** "has origin" doesn't prove "can push" — a revoked PAT or protected branch passes
  today's local-only check while the backup silently rots. **Pros:** turns the verdict from
  "configured" into "verified". **Cons:** network + auth in a check that is deliberately
  offline today; must stay opt-in. **Context:** v1 holds the no-network line by design; the
  seam is `BackupCoverageOpts` in `src/core/backup/coverage.ts` (add a `probe` flag beside
  `localGitProbes`). Effort: M → S with CC. Depends on: the backup-check feature (landed).
- [ ] **P2 — Codex/opencode hook lanes for parity with Claude Code.**
  **What:** flip `CODEX_HAS_HOOKS`/`OPENCODE_HAS_HOOKS` (`src/core/bootstrap/host-specs.ts:341/:421`)
  and wire `gbrain hook` into codex 0.147+'s hooks.json so those harnesses get the
  session-start digest + banner rail. **Why:** today their only backup-notice reach is the
  MCP aggregate block + CLI stderr; Claude Code users get a human-visible systemMessage.
  **Pros:** closes the harness-reach gap for every hook-borne notice, not just backup.
  **Cons:** new host-integration surface to maintain per harness release. **Context:** the
  backup check's render channels are already shaped for it — a codex hook lane would reuse
  `backupSessionStartNote`/`pendingBackupBanner` unchanged. Effort: L → M with CC.
- [ ] **P3 — Neutralize repo-local git config execution vectors in the read-only probe env.**
  **What:** add `-c core.fsmonitor= -c core.hooksPath=` (and consider `core.sshCommand`) to the
  read-only git probe invocations (`GIT_ENV` / `buildGitInvocation` consumers: `hasOriginRemote`,
  `isWorkingTreeDirty`, `detectDefaultBranch`, `aheadCount`, the backup-coverage probes).
  **Why:** `git status` honors `core.fsmonitor` from the TARGET repo's own `.git/config`; the
  backup check now runs probes automatically and periodically across every source root, so a
  hostile config planted inside any registered tree executes monthly without user action.
  **Cons:** touches every existing git caller (sync, doctor, durability) — needs its own test
  sweep; exploiting already requires local write access (D4 holds), so this is defense-in-depth.
  **Where to start:** `src/core/git-remote.ts:GIT_ENV` + `src/core/sync-git.ts:buildGitInvocation`.
- [ ] **P3 — Notice-center rail: one cross-feature nag system.**
  **What:** extract a shared notice rail (per-channel nag state, dampening, render
  adapters) and migrate the backup nag, the push-failure banner (`hook.ts`
  `pendingPushFailureBanner` + `.announced` sidecars), and the upgrade nag
  (`self-upgrade.ts` snooze) onto it. **Why:** three parallel nag systems with three state
  formats is debt; every new periodic notice re-invents cadence + budget logic. **Pros:**
  one budget across ALL notices (no cross-feature nag pileups); one place to test.
  **Cons:** touches load-bearing hook code; needs migration for existing state files.
  **Context:** `src/core/backup/status-file.ts`'s gate (per-channel entries + dampener +
  global monthly cap, enforced uniformly in `record()`) is deliberately shaped as the seed.
  Effort: M-L. Blocked by: the backup-check feature shipping first.

## brain-repo durability follow-ups (filed v0.42.48.0)

- [ ] **P3 — gbrain write-path calls commit-push synchronously when durability is on.**
  v0.42.48.0 ships the synchronous `brain-commit-push.sh` as the guarantee and a local
  post-commit hook as a best-effort fallback. The strongest durability (codex outside-voice
  D13-C) is to have gbrain's own write-through path call the commit-push helper synchronously
  when a source is hardened — that also covers writes that never get committed by an agent.
  Deferred because it touches the write path; the hook + mandated helper cover the
  agent-driven case today.
  - **Where to start:** `src/core/write-through.ts:writePageThrough` + a per-source "hardened"
    flag to gate the synchronous push.

- [ ] **P3 — Unify the durability pull cron with autopilot's OS-scheduler.**
  v0.42.48.0 ships a minimal launchd/crontab installer inside `brain-repo-durability.ts`
  (D12: minimal-now to keep the diff off the load-bearing autopilot feature). Extract a shared
  `os-scheduler.ts` (`installPeriodic`/`removePeriodic`) and have both autopilot and brain-pull
  call it, so there's one OS-cron path.
  - **Where to start:** `src/commands/autopilot.ts` (`installLaunchd`/`installSystemd`/
    `installCrontab`/`writeWrapperScript`) + `brain-repo-durability.ts:installDurabilityCron`.

## gbrain#2200 federated-read follow-ups (filed v0.42.46.0)

- [ ] **P1 — Close the federated-read scope on the remaining same-class by-slug read ops.**
  v0.42.46.0 (#2200) routed `get_page` tags + `get_tags` / `get_links` / `get_backlinks` /
  `get_timeline` through the federated source scope and taught the engine methods to honor
  `sourceIds[]`. The adversarial review (Codex + Claude) flagged sibling read ops in the
  SAME class that still use scalar-only `ctx.sourceId ? {sourceId} : {}` and never thread
  `ctx.auth.allowedSources`: `get_chunks`, `get_raw_data`, `get_versions`, `resolve_slugs`
  (the standalone op — `resolve_slugs` passes NO scope at all), plus (per the v0.42.55.0
  eng-review codex pass) `takes_search` (`operations.ts:1727` — holder-allowlist only, no
  `sourceScopeOpts`) and `code_def` (`operations.ts:4155` — brain-wide raw SQL over
  `content_chunks`; confirm whether brain-wide is intentional before scoping). A remote
  federated client (grant set, dispatch-default `ctx.sourceId='default'`) reads these against
  `default` or unscoped, not its grant.
  - **Why:** same cross-source correctness/isolation class #2200 targets; a federated client
    can't read chunks/raw-data/versions for an authorized non-default source, `resolve_slugs`
    can fuzzy-resolve across all sources, and `takes_search`/`code_def` query without the grant.
    The #2399 close-list deliberately did NOT blanket-close #1371/#2200 because of these residual
    surfaces — close those issues only after this TODO lands.
  - **How to start:** mirror the #2200 pattern — route each handler through `sourceScopeOpts(ctx)`
    (or `linkReadScopeOpts` if a far endpoint exists), add `sourceIds?: string[]` to the engine
    methods (`getChunks` / `getRawData` / `getVersions` / `resolveSlugs` / the takes-search +
    code-def queries) with `source_id = ANY($::text[])` precedence, and add federated/isolation
    tests + engine-parity arms.
  - **Depends on:** nothing; #2200 established the pattern and the `linkReadScopeOpts` helper.

## Spend-controls wave follow-ups (filed v0.42.45.0, #2139)

Deferred from the #2139 delta-estimator wave. See plan + GSTACK REVIEW REPORT at
`~/.claude/plans/system-instruction-you-are-working-lovely-balloon.md`.

- [ ] **P3 — Measured post-import chunk-count gating (#2139 proposal 2b).**
  **What:** Gate the inline cost decision on the actual chunk count sync produced
  (known after import, before embedding) instead of the pre-sync token estimate.
  **Why:** A fully execution-accurate gate with zero estimate error. **Context:**
  After v0.42.42.0 the estimator already mirrors execution (fetch-first delta via the
  shared `computeSyncDelta`, `--full`=delta+stale, dirty-tree→$0). This is the
  belt-and-suspenders fallback if a future case still drifts. **Trigger:** only if the
  delta estimator proves insufficient in practice. **Start:** the gate call site in
  `src/commands/sync.ts` (`runInlineCostGate`), gate on post-import `chunksCreated`.
- [ ] **P3 — Per-source defer granularity (#2139, D8A road-not-taken).**
  **What:** When the aggregate inline gate trips in a non-TTY session, defer embeds
  only for sources above a per-source floor; let cheap sources keep embedding inline.
  **Why:** Cheap sources would get embeddings minutes sooner instead of waiting for a
  backfill-worker drain. **Context:** v0.42.42.0 chose GLOBAL defer (one flag, strictly
  dominates the exit-2 it replaced). This is the granularity upgrade. **Trigger:** a
  filed embedding-latency-by-minutes complaint. **Start:** thread per-source estimates
  through `runOne` (`src/commands/sync.ts`); design worked out at D8A in the plan.

## Harness hook lane follow-ups (filed from the cathedral-3 convergence)

Filed when the cathedral-3 branch converged its push-adapter work into the
#3975 hook lane (feedback loop + cross-turn dedupe for `gbrain hook
user-prompt`). Context: the hook lane now logs channel-attributed volunteer
events at the IPC delivery point and dedupes via the transcript's
`hook_additional_context` attachments.

- [ ] **P3 — PostToolUse / mid-turn push adapter, evaluated against per-channel stats.**
  The user-prompt hook fires at prompt time only; entities that first appear mid-turn
  in tool output (a file opened, a person named in a search result) get no pointer
  until the NEXT prompt. Harnesses expose a PostToolUse hook, but it fires dozens of
  times per turn (one `gbrain hook` process spawn each). Now that the feedback loop
  exists, the per-channel `--stats` precision + volume data is exactly the evidence
  needed to decide. **Trigger:** claude-code channel stats showing healthy precision
  plus user reports of "it only noticed on my next message". **Start:**
  `src/commands/hook.ts` (the event already has a dispatch slot pattern),
  `src/core/bootstrap/hooks.ts` registration writers.
- [x] **P3 — engine-uniform IPC listener (Postgres serves).** DONE (#4245): serve now
  listens for Postgres brains too — socket + turn_context secret key off
  `hash12(database_url)` under `~/.gbrain/run` (0700) via
  `resolveSocketPathForConfig`/`ipcSecretPathForConfig` in
  `src/core/context/resolve-ipc.ts`; the hook lane's user-prompt/compact/
  session-start arms route through the same resolver. Original filing:
  serve's resolve/turn_context
  socket was PGLite-gated (`src/mcp/server.ts`: `cfg?.engine === 'pglite'`), so on a
  Postgres brain `gbrain hook user-prompt` short-circuited (`no_pglite_path`) and the
  hook lane was PGLite-only. Extending the listener needs (a) a canonical per-connection
  socket path for brains with no data dir (e.g. `~/.gbrain/run/resolve-<hash12(database_url)>.sock`,
  0700 dir) and (b) a secret-file home for `turn_context` auth (same hash-keyed run dir).
  The cathedral-3 branch prototyped (a) as `resolveSocketPathForConfig` (see branch
  history at commit 2350294c) before the convergence dropped it pending the secret
  design. **Trigger:** a Postgres-brain user asking why hooks stay silent — and as of
  #4043, every `gbrain bootstrap harness` install on a Postgres brain: harness mode
  pre-wires all five hooks and states the degradation plainly, so this listener is what
  lights them up. **Start:**
  `src/core/context/resolve-ipc.ts` socket-path helpers + `src/mcp/server.ts` listener gate
  + `src/commands/hook.ts:no_pglite_path` branch.
- [ ] **P3 — thin-client remote push route.** Thin-client installs (remote_mcp) have no
  local engine and no serve socket — every push channel is dead there and only the
  hook's typed heartbeat reason says why. The natural route is `volunteer_context`
  over the remote MCP transport (`callRemoteTool`), rate-limited per prompt.
  **Trigger:** thin-client adoption of bootstrap. **Start:** `src/commands/hook.ts`
  user-prompt branch + `src/cli.ts` remote-tool plumbing.

## gbrain#2095 push-based context follow-ups (v0.43+)

Filed from the #2095 wave (volunteer_context op + reflex window + `gbrain watch`).
Deliberately scoped OUT of v1 per the eng-review scope decision (success criteria
are the bar). Plan + GSTACK REVIEW REPORT at
`~/.claude/plans/system-instruction-you-are-working-cheerful-elephant.md`.

- [ ] **P3 — SSE/HTTP push channel via serve-http.** The op + `gbrain watch` cover
  pull-per-turn and stdin streaming; a serve-http SSE feed would push volunteered
  pages to remote agents without a local CLI. **Why:** thin-client/remote-MCP
  deployments get push too. **Cons:** async plumbing + auth scoping; no consumer
  wired today. **Where:** `src/commands/serve-http.ts` + `src/core/context/volunteer.ts`.
  **Blocked by:** a real consumer (revisit when one exists).
- [ ] **P3 — policy skill (recipe) for push-context.** The doctor-check half of
  this item shipped with the harness hook lane: `volunteer_channels`
  (`src/commands/doctor.ts:checkVolunteerChannels`) reads the events table
  per-channel on both the local and remote doctor. Remaining scope: if
  `volunteer-context --stats` adoption shows agents not discovering the
  surface, ship a `push-context` recipe (mirror `recipes/retrieval-reflex/`).
  **Where:** `recipes/`.
- [ ] **P3 — structured `messages[]` param for volunteer_context.** v1 takes a
  string window (`user:`/`assistant:` prefixes) to avoid a dual-shape contract.
  If MCP callers accumulate parsing bugs, add a structured array param beside it.
  **Where:** `src/core/operations.ts:volunteer_context` + `src/core/context/volunteer.ts:parseWindow`.
- [ ] **P3 — index shapes for the per-turn resolver query.** The arm-2 resolver
  (`retrieval-reflex.ts`: `lower(title) = ANY() OR slug = ANY() OR slug LIKE
  ANY('%/...')`) predates #2095 but now runs per turn on four channel surfaces
  (reflex window, volunteer_context, watch, and the harness-hook `turn_context`
  lane) federated across sources. Neither
  the leading-wildcard suffix arm nor `lower(title)` is index-served. If
  per-turn latency telemetry on large brains comes back hot: add
  `(source_id, lower(title))` btree + a reverse(slug) text_pattern_ops (or
  gin_trgm) index, or split the OR into three index-friendly queries.
  **Where:** `src/core/context/retrieval-reflex.ts`, migration.
- [ ] **P3 — batch the volunteer-events pruner's first run after a long gap.**
  `purgeStaleVolunteerEvents` is one unbatched DELETE with a bare
  `volunteered_at` predicate (full scan; fine for a TTL-bounded table). Edge:
  a brain whose dream cycle was off for months could hit the pooler's ~2min
  statement_timeout on the first prune, get swallowed by the catch, and never
  make progress. If observed: id-batched chunks (`DELETE ... WHERE id IN
  (SELECT ... LIMIT 10000)` looped). **Where:**
  `src/core/context/volunteer-events.ts:purgeStaleVolunteerEvents`.
- [ ] **P3 — route `gbrain watch` through the serve resolve-IPC on PGLite.**
  `watch` connects directly, so on a PGLite brain it monopolizes the single
  connection for its whole (potentially hours-long) session — a concurrent
  `gbrain serve` or any write path blocks on the lock until watch exits.
  WATCH_HELP documents the monopoly; the fix is an IPC rung in watch's
  resolver (reuse `resolveViaIpc` like the ambient reflex's ladder) so a
  running serve answers and watch never takes the lock (v0.46.24.0's
  serve-delegated sync built the additive-kind groundwork — `sync_start`/
  `sync_status` in resolve-ipc.ts are the pattern to copy). **Why:** watch +
  serve concurrently is the natural agent topology. **Where:**
  `src/commands/watch.ts`, `src/core/context/resolve-ipc.ts` (red-team RT2).
- [ ] **P3 — capability/version gate for host-injected reflex resolvers.**
  Windowing switched the orchestrator's suppression request to 'slug-only';
  a host resolver built against the pre-window contract that still applies
  title-whole-word suppression silently self-suppresses every windowed
  entity. The contract is documented at `ResolveEntitiesFn` (reflex.ts), but
  nothing detects a stale host. Add a capability handshake (e.g. resolver
  advertises `supportsSuppressionModes`) and fall back to
  `window_turns: 1` semantics when absent. **Where:**
  `src/core/context/reflex.ts:ResolveEntitiesFn` + the OpenClaw plugin
  contract (red-team RT4).

## gbrain triage wave follow-ups (filed v0.42.41.0)

Deferred from the v0.42.41.0 fix wave (eng-reviewed as separate scope, not hotfixes).
See plan + GSTACK REVIEW REPORT at
`~/.claude/plans/system-instruction-you-are-working-zany-thacker.md`.

- [ ] **P1 — supervisor: retry-with-backoff instead of hard stop on transient DB outages (#1994).**
  `max_crashes_exceeded` gives up permanently; a transient pooler blip that trips the
  counter wedges the supervisor until manual restart. **Why:** the #2034 reconnect fix
  makes the engine recover, but the supervisor still hard-stops. **Where:**
  `src/core/minions/supervisor.ts` crash-count loop — add exponential backoff with a
  much higher (or no) permanent-give-up threshold for recoverable errors.
- [ ] **P2 — PGLite `reindex-frontmatter` / backfill statement_timeout boost (#1963).**
  Community RCA: `SET LOCAL statement_timeout` is gated on `engine.kind === 'postgres'`,
  so PGLite inherits the 30s session default and trips on non-trivial batches; the CLI
  then swallows the error and exits 0. **Where:** `src/core/backfill-effective-date.ts`
  (boost on PGLite too, or per-row updates) + the cli.ts catch that hides it.
- [ ] **P2 — autopilot drain-worker concurrency self-deadlock (#2050).** Drain-worker
  runs at concurrency=1, so any cycle phase that spawns a subagent (patterns, synthesize)
  deadlocks waiting on a worker slot it can't get. **Where:** autopilot drain-worker
  dispatch — raise concurrency or exempt subagent-spawning phases.
- [ ] **P3 — name-keyed migration ledger (#2038 structural follow-up).** The always-run
  index drift probe heals the one known case; the general fix is keying applied-migration
  tracking by stable name rather than version integer so a renumber can't strand a
  migration as recorded-but-not-executed. **Where:** `src/core/migrate.ts` ledger.

## gbrain#1981 Retrieval Reflex follow-ups (v0.43+)

Filed from the #1981 ship (v0.42.39.0). Deliberately scoped OUT — the v1 extractor
is deterministic + precision-biased. See plan + GSTACK REVIEW REPORT at
`~/.claude/plans/system-instruction-you-are-working-wild-yeti.md`.

- [ ] **P3 — broaden entity detection beyond the current passes.** MOSTLY DONE by
  later waves — the remaining gaps are narrower than this entry's original claim
  (updated by the eval fix wave, 2026-08-31): lowercase Latin names now emit as WEAK
  candidates resolved via the alias arm (v0.46.15, kta 0.150→0.0000 in
  `evals/brainbench/baselines/main.json`), CJK names via weak n-grams (#3746).
  STILL OPEN: lowercase SURNAME-only mentions ("did galewright follow up" — weak
  candidates never reach the surname arm, retrieval-reflex.ts:195-230), caseless
  non-CJK scripts (Arabic/Hebrew/Devanagari/Thai — \p{Lo} invisible to both passes),
  pure-hiragana grams, and true pronoun coreference (LLM-pass idea). **Where:**
  `entity-salience.ts`, `retrieval-reflex.ts`.
- [x] **P3 — recall knob: optional fuzzy/prefix-expansion resolution.** RESOLVED
  differently by the v0.46.15 identity wave, with a receipt: trigram fuzzy in the
  reflex is deliberately REJECTED — the BrainBench adversarial near-miss class
  (`"<Name>er"` for a real `<Name>` page) is gold-silent and any usable trigram
  threshold would false-fire on it. The recall gap the fuzzy arm targeted was
  closed by exact NORMALIZED-LEXICAL arms instead: the lowercase weak-alias arm
  + the surname arm (know_to_ask 0.15→0, push_recall +9.6pp, false_fire/precision
  unmoved). Do not re-add trigram here without a fixture that defeats the
  near-miss class first.

## gbrain#1972 job-layer follow-up (v0.43+)

Filed from the #1972 fix (stale-lock reaper + bounded disconnect + complete
cooperative-abort). One item was deliberately gated, not deferred blindly. See plan +
GSTACK REVIEW REPORT at `~/.claude/plans/system-instruction-you-are-working-curious-pike.md`.

- [ ] **P2 — `findBacklinkGaps` sync→async refactor (gated on telemetry).** The backlinks
  phase does its heavy work in a single synchronous call (`findBacklinkGaps`,
  `src/commands/backlinks.ts:71` — nested `readdirSync` double-walk, no `await` seam), so it
  cannot be cooperatively aborted: a >30s run on a huge brain blocks the event loop and gets
  force-evicted. lint was made yield-able this wave (it was already async); backlinks needs
  `findBacklinkGaps` converted to async-with-periodic-yields, threaded through
  `runBacklinksCore` + `runPhaseBacklinks`. **Why gated:** the trigger is UNCONFIRMED — we
  don't know backlinks ever exceeds 30s. This wave added the phase-duration force-evict
  attribution log (`FORCE_EVICT_DEADLINE_MS` in `src/core/cycle.ts`), which names any phase
  that crosses the deadline. Do this refactor only if a production 24h pull shows backlinks
  crossing it; otherwise it's a hot-loop rewrite for a non-occurring case. **Where:**
  `src/commands/backlinks.ts`, `src/core/cycle.ts` (runPhaseBacklinks signal threading).

## gbrain#1881 sync reclone ownership follow-ups (v0.43+)

Filed from the #1881 fix (`gbrain sync --strategy code` deleted a user's working
tree; `recloneIfMissing` now only re-clones a clone gbrain OWNS — `config.managed_clone`
marker or exact default-location equality — via `isOwnedClone`). Deliberately scoped
OUT of that PR. Codex outside-voice findings #5/#6. See plan + GSTACK REVIEW REPORT at
`~/.claude/plans/system-instruction-you-are-working-golden-valiant.md`.

- [ ] **P2 — `gbrain doctor` misconfigured-source check.** Flag every source row
  where `config.remote_url` is set but `isOwnedClone(row)` is false (the shape that
  caused #1881: a federated row whose `local_path` is a user working tree). Print a
  one-time, actionable hint per row: drop `config.remote_url` to sync it read-only,
  or remove + re-add with `--url` so gbrain owns the clone. **Why:** the core guard
  now refuses to delete such rows, but they still exist in users' brains (created by
  the gstack orchestrator). This is the single surfacing point — it replaces the
  per-sync stderr warning that was rejected during eng-review (Codex: it would spam
  every healthy sync). **Where:** extend the doctor checks in `src/commands/doctor.ts`;
  reuse `isOwnedClone` from `src/core/sources-ops.ts`. No migration.

- [ ] **P3 — Decide the `--clone-dir`-outside-root policy.** `gbrain sources add --url
  --clone-dir <path>` lets local callers place a gbrain-owned clone anywhere. The
  ownership marker (this PR) makes those safe to reclone, but the dormant
  `clone_dir_outside_gbrain` code in `SourceOpErrorCode` (`sources-ops.ts`) is unused —
  it hints at a previously-intended confinement rule. Decide: either wire it up (forbid
  `--clone-dir` outside `$GBRAIN_HOME/clones/`) or delete the dead code. Don't leave it
  half-implemented. Codex finding #5.

- [ ] **P2 — Harden the `managed_clone` ownership marker against forgery.** Ownership
  (`isOwnedClone`) authorizes the destructive reclone swap on the strength of a DB JSON
  boolean (`config.managed_clone`). Today only `addSource --url` writes it, but it's a
  mutable field any future `set-config` / external INSERT / restored dump could set on a
  user-tree path. A forged marker on a real (non-symlink) user path would authorize
  deletion. (A realpath path-check does NOT close this — it false-positives on ubiquitous
  system symlinks like macOS /var, and an owned clone gbrain created is legitimately
  deleted through any operator symlink anyway. Path can't prove ownership.) Two follow-ups:
  (a) a CI guard asserting NO code path other than `addSource` ever writes the
  `managed_clone` key; (b) bind ownership to an unforgeable on-disk stamp (a `.gbrain-clone`
  sentinel written into the clone at creation, verified before any destructive op) instead
  of / in addition to the DB field — with an equality-fallback for pre-stamp clones. Codex
  adversarial (High) + Claude adversarial (Finding 2) from the #1881 ship review.

- [ ] **P3 — Sweep orphaned `.gbrain-reclone-*` temp dirs.** The EXDEV-safe reclone clones
  into a sibling temp of `local_path` (`.gbrain-reclone-<leaf>-<rand>`). Every error path
  `rmSync`s it, but a hard crash (SIGKILL/power loss) between clone and swap leaves a full
  clone orphaned next to the user's `--clone-dir` parent — outside gbrain's swept
  `clones/.tmp`. Add a startup/doctor sweep for `.gbrain-reclone-*` / `*.old-*` older than N
  minutes. Codex Medium / Claude Finding 4 from the #1881 ship review.

- [ ] **P3 — CLI `gbrain sources remove` leaks the managed clone dir.** `runRemove`
  (`src/commands/sources.ts:269`) runs `DELETE FROM sources` directly, bypassing
  `removeSource()` and its symlink-safe clone-cleanup guard — so removing a `--url`
  source never deletes its on-disk clone (storage leak). Route CLI remove through
  `removeSource()` (or replicate its guard) so the clone dir is cleaned with the same
  ownership/symlink protections. Orthogonal to the deletion bug; surfaced by Codex
  finding #6 during the #1881 review.

## #1737 minion fair-scheduling follow-up (v0.43+)

Filed during the #1737 wave (`/plan-eng-review` decision F7, codex outside-voice
line 5 + Claude review agreeing). The wave shipped honest attempt accounting,
cooperative abort-honoring (the daily cycle-wedge fix), and per-handler default
timeouts. Slot reservation was deliberately deferred.

- [ ] **P3 — Reserve a concurrency slot for short lanes so long jobs can't starve
  fresh ones.** Today the worker claim loop (`src/core/minions/worker.ts` claim
  loop) pulls from a single pool ordered by `priority, created_at` — N long
  `subagent`/`embed-backfill`/`autopilot-cycle` jobs can occupy all slots while a
  freshly-submitted short job waits (#1737's "fresh subagent never claimed"
  half). **Why deferred:** now that abort is honored (this wave), a timed-out job
  actually stops and frees its slot, so most of the observed starvation should
  evaporate. **MEASURE FIRST:** before building reservation, confirm starvation
  still reproduces with abort-honoring live (submit a short job alongside 3 long
  ones at `--concurrency 3`; check it gets claimed). Reserving a slot is overfit
  (breaks at `--concurrency 1`; can starve long work under continuous short
  traffic), so only build it if the measurement shows a real residual problem.
  **Shape if needed:** when all-but-one in-flight slot is held by long-lane
  handler names, restrict the next `claim()` to non-long names via the existing
  `name = ANY($4)` filter in `queue.ts:claim`. No new table/migration.
## gbrain#1861 JSONB batch-insert follow-ups (v0.42+)

Filed from the #1861 fix (batch inserts migrated from `unnest(${arr}::text[])` to
`jsonb_to_recordset` to stop the "malformed array literal" crash on free-text
context). Deliberately scoped OUT of that PR. See plan + GSTACK REVIEW REPORT at
`~/.claude/plans/system-instruction-you-are-working-velvety-garden.md`.

- [ ] **P3 — Element-isolation fallback for batch inserts.** On a non-retryable
  batch error, retry the batch element-by-element so one bad row can't abort a
  353K-page `extract --stale` sweep, logging the offending `(from_slug, context)`
  instead of dying. The durable JSONB fix removed the known crash class (malformed
  array literal), NUL-stripping removed a second jsonb-parse failure, and
  v0.42.40.0 lone-surrogate well-forming (#2011) removed a third, so there is no
  remaining *known* data-dependent crash for this to catch *today* — it's
  belt-and-suspenders against unknown future per-row failures. Wire it in
  `addLinksBatch`/`addTimelineEntriesBatch`/`addTakesBatch` (or in `batchRetry` as
  a post-classification fallback). Issue #1861 option 2.

- [ ] **P3 — Audit remaining `unnest(${arr}::text[])` write sites.** `setPageAliases`
  (alias_norm) and `addCodeEdges` (symbol-qualified names + `metas::jsonb[]`) still
  bind through text-array literals. They carry normalized identifiers / symbol names,
  not free prose, so the crash risk is far lower than calendar context — but they are
  the same bug class and a hostile alias/symbol (or an embedded NUL) could still trip
  them. Migrate to `jsonb_to_recordset` via the shared `batch-rows.ts` pattern if/when
  one is observed failing, or proactively for completeness. `markPagesExtractedBatch`
  is NOT in this set (slugs/source-ids/timestamps only — no free text).


- [ ] **P3 — Single-source the batch INSERT SQL strings.** After #1861 the
  links/timeline/takes `INSERT ... jsonb_to_recordset(($1::jsonb)->'rows')` SQL is
  byte-identical between `postgres-engine.ts` and `pglite-engine.ts` (row builders already
  hoisted to `batch-rows.ts`, but the SQL text is still duplicated). Hoist the three SQL
  strings into exported constants in `batch-rows.ts` so a recordset column added to one
  engine can't silently drift from the other. `test/e2e/engine-parity.test.ts` pins
  behavior; a shared constant prevents drift at edit time. (Maintainability specialist.)

- [ ] **P3 — Backfill batch-insert edge-case tests.** Edges sharing already-covered helper
  code but lacking direct assertions: (a) `addTakesBatch` retries on an injected retryable
  error + AbortSignal aborts (the `batchRetry` wrap is proven for links/timeline; takes
  inherits the identical wrapper but isn't exercised directly); (b) `addTakesBatch`
  intra-batch duplicate `(page_id,row_num)` rejects under `ON CONFLICT DO UPDATE`
  (comment-claimed, unasserted). (Testing specialist.)

- [ ] **P3 — Enforce a max batch size on the JSONB bulk inserts.** One JSONB datum
  is not unbounded (server-side parse/memory ceiling). In-tree callers chunk well
  under any limit (extract ~100, NER ~500), and `batch-rows.ts` documents "chunk
  ~1-5K rows", but nothing enforces it for an external direct-engine caller passing
  a giant batch. Consider a `BATCH_INSERT_MAX` constant + a clear throw, mirroring
  the existing `DELETE_BATCH_SIZE` valve in `deletePages`. Deferred because no
  in-tree caller hits it and the cap value is a judgment call. (Codex #1861 P2b.)

## v0.42.21.0 module-singleton ownership follow-ups (v0.42+)

Filed from the v0.42.21.0 wave (#1404/#1471/#1619 — the dream-cycle
"connect() has not been called" class, fixed via `_ownsModuleSingleton`).
Surfaced by the Codex outside-voice review (finding #4) and deliberately scoped
OUT — pre-existing, and the ownership fix *reduces* its window. See plan +
GSTACK REVIEW REPORT at
`~/.claude/plans/system-instruction-you-are-working-lazy-allen.md`.

- [ ] **P3 — Stale `ConnectionManager` read-pool after an owner `reconnect()`.**
  A module-style borrower engine caches the singleton at connect time via
  `connectionManager.setReadPool(db.getConnection())` (`postgres-engine.ts:~208`).
  When the OWNER engine calls `reconnect()` (the batchRetry path), it tears down
  the old module singleton and builds a fresh one — but the borrower's
  `connectionManager` still holds the OLD (ended) pool. The borrower's normal
  query path is fine (`this.sql` → `db.getConnection()` resolves the NEW
  singleton), so this is invisible on read/write. The edge is
  `initSchema()`, which routes DDL through `connectionManager.ddl()`
  (`postgres-engine.ts:~253`) — a borrower running initSchema after an owner
  reconnect would hit the dead pool. Pre-existing (not introduced by #1471), and
  the ownership fix makes owner reconnects *rarer* (the singleton no longer gets
  nulled by borrowers, so reconnect only fires on genuine transient drops), which
  shrinks the window. Real fix: refresh a borrower's `connectionManager` read
  pool lazily from `db.getConnection()` on use, or have `db.connect()`/reconnect
  publish a generation counter the manager checks. Defer until a borrower is
  observed running `initSchema()` mid-process (no current caller does).

- [ ] **P2 — Ownership state can desync from the shared singleton under
  CONCURRENT module connect/reconnect.** Both adversarial reviewers (Codex +
  Claude) independently flagged this. `_ownsModuleSingleton` is per-engine state
  about a shared (module-level) resource, so it can migrate: if a borrower calls
  `connect()`/`reconnect()` during the window when an owner's `reconnect()` has
  nulled `sql` (`db.ts` snapshot-early-null) but not yet rebuilt it, the borrower
  creates the new singleton and becomes owner; the owner re-connects as a
  borrower; the short-lived borrower's later `disconnect()` then closes the live
  pool the demoted owner still uses — the original bug, in reverse. ALSO: the
  audit-import + `connectionManager.disconnect()` awaits in `PostgresEngine.disconnect()`
  and the publish-before-`SELECT 1` window in `db.connect()` let a concurrent
  connect join a dying/unverified pool. NOT REACHABLE in current gbrain — cycle
  phases are sequential on one awaited engine, borrowers are nested within a
  phase, the parallel-sync worker pool uses INSTANCE engines (not the singleton),
  and facts/last-retrieved background writes reuse the owner engine (no second
  module engine). The ownership fix is correct for every reachable path and is
  fully tested. The structural fix (which removes the unenforced "no concurrent
  module connect" invariant) is the refcount/lease-in-db.ts approach Codex argued
  in the plan review: keep the lifecycle state WITH the shared resource so it
  can't desync per-engine, bounded against CLI-hang by a top-level forced
  cleanup. Do this BEFORE introducing any concurrent module-engine connect path.

- [x] **P3 — `dream` + CLI_ONLY fall-through paths don't drain the facts /
  last-retrieved queues before the owner disconnect.** DONE in the #2084 fix:
  `finishCliTeardown` (`src/core/cli-force-exit.ts`) is exactly the shared
  drain-before-disconnect helper this item asked for, and ALL NINE cli.ts
  disconnect sites route through it (op-dispatch, fall-through, dream, doctor
  ×3, ze-switch, search dashboard, read-only timeout path). Structural guard:
  no bare `await engine.disconnect()` remains in cli.ts
  (`test/fix-wave-structural.test.ts` `#2084` describe).

- [ ] **P2 — command-module `process.exit` sites bypass the #2084 teardown
  contract.** Several CLI_ONLY command modules exit directly on their normal
  paths (`doctor.ts` ~10 sites incl. its verdict exit, `dream.ts` ~23,
  `ze-switch.ts` ~9, plus friction/claw-test/eval verdict exits in cli.ts) —
  those exits preempt the call-site `finally`, so the background-work drain,
  bounded disconnect, and `flushThenExit` grace are all skipped on those paths
  (pre-existing class, NOT introduced by #2084; pre-fix the same exits skipped
  the inline drains too). Consequences: `gbrain doctor --json | <slow reader>`
  keeps the #1959 truncation exposure; a dream path that exits mid-cycle
  discards in-flight facts/search-cache writes. Fix shape: convert in-command
  `process.exit(n)` to `setCliExitVerdict(n)` + return (the central seam
  exits), or route them through a shared `exitCommand(n)` helper that runs
  teardown first. Surfaced by the #2084 cross-model adversarial review (F2).

- [ ] **P3 — opt-in whole-command wallclock cap (`GBRAIN_COMMAND_DEADLINE_MS`),
  build ONLY on a real wedged-handler incident.** The #2084 fix deliberately
  removed the blanket pre-handler 10s force-exit (it killed slow-legit ops with
  exit 0 and truncated output); per-op deadlines (query-embed deadline,
  `withTimeout` on read-only commands) own handler wallclock now, and
  `connectEngine` hangs — the historically observed zombie class — were never
  covered by the old timer anyway. If production ever shows a genuinely wedged
  handler (trigger: a non-`serve` command alive >30min with no progress
  output), add an opt-in env cap that exits NON-ZERO with a truthful banner.
  Attach point: the `GBRAIN_TEARDOWN_DEADLINE_MS` / `computeTeardownDeadlineMs`
  plumbing in `src/core/cli-force-exit.ts`. Do not build speculatively —
  follow-up from the #2084 eng review (decision D2/D14).
## v0.42.x AI SDK v6 tool-schema fix follow-ups (#1782/#1764)

Surfaced by the codex outside-voice pass during `/plan-eng-review` and
deliberately scoped OUT of the tool-schema fix (it's pre-existing + a separate
structural change). Plan + GSTACK REVIEW REPORT at
`~/.claude/plans/system-instruction-you-are-working-abstract-willow.md`.

- [ ] **P1 — Gateway toolLoop crash-replay sends a malformed ModelMessage
  history.** The gateway path never persists the tool-result feedback message:
  `toolLoop` pushes `{role:'user', content: toolResultBlocks}` with `void
  messageIdx` and NO persistence callback, so only assistant turns reach
  `subagent_messages` (via `onAssistantTurn`). On any multi-turn resume,
  `loadPriorMessages` (`subagent.ts:769`) returns
  `[user, assistant(tool-call), assistant(...), ...]` with the tool-result
  messages MISSING — a history the real AI SDK v6 rejects ("tool result missing
  for tool call"). The direct-Anthropic path reconciles this at
  `subagent.ts:334-418` (synthesize + persist the tool-result turn before the
  first chat call); the gateway branch does not. **Fresh runs — the actual
  #1782/#1764 reports — are unaffected**, which is why the tool-schema fix
  shipped without it. Two fix options: (a) add an `onToolResults` persistence
  callback to `toolLoop` so the feedback message lands in `subagent_messages`,
  or (b) mirror the direct-path reconciliation in the gateway branch of
  `subagent.ts` before the first `gatewayToolLoop` chat. Either is a structural
  change to the replay contract — own PR, own review. Caught because every
  toolLoop/replay test stubs the transport and never inspects the input
  messages; pair the fix with a `MockLanguageModelV3 + generateText` replay test
  (the seam landed in `test/ai/gateway-tools-schema.test.ts`).

- [ ] **P2 — SkillOpt `best.md` not written in `--no-mutate` runs.** From PR
  #1708 (scoped out of the tool-schema wave as tangential): in `--no-mutate`
  SkillOpt runs the accepted proposal isn't persisted because `acceptCandidate`
  is gated by the mutate decision. Write it explicitly via `atomicWrite`
  (`apply-edits.ts:311`) + `mkdirSync(recursive)` in
  `runOptimizationLoop` (`src/core/skillopt/orchestrator.ts`). Small, own PR.

## Minion-lock direct-pool follow-up (v0.42+)

Filed from the eng-review of the lock-claim/renewLock → direct-session-pool fix
(PR #1816, now folded into `garrytan/minion-locks-session-pool`). Deliberately
scoped OUT of that change; not a regression.

- [ ] **P3 — Size the direct session pool for enrich fan-out.** The lock
  hot-path (`claim`/`renewLock`) now routes through the direct session-mode pool
  (port 5432) via `executeRawDirect`. Supabase's session-mode pool has a far
  smaller connection ceiling than the transaction pooler (6543). `executeRawDirect`
  checks out per-statement (not held open), so the risk is bounded by *concurrent
  in-flight heartbeats*, not duration — but under heavy `enrich` fan-out (many
  Minion workers each heartbeating at once) the smaller pool could contend or
  exhaust. **Why:** a starved session pool would reintroduce the exact wedge class
  the fix removes, just from a different cause. **Current state:** direct pool size
  comes from `resolveDirectPoolSize` / `DEFAULT_DIRECT_POOL_SIZE`
  (`src/core/connection-manager.ts`); no fan-out-aware tuning. **Where to start:**
  measure concurrent heartbeat count under a realistic `enrich` burst, compare to
  `DEFAULT_DIRECT_POOL_SIZE`, and either raise the default or add a
  worker-count-aware knob. **Depends on:** PR #1816 landing first.

## v0.42.12.0 #1685 brain-health-as-solved follow-ups (v0.42+)

Deferred from the v0.42.12.0 wave (issue #1685, the posture umbrella over #1678/#1735).
The shipped checks (`worker_oom_loop`, `pool_reap_health`, cause-ranked `top_issues`,
per-source auto-drain) cover the diagnosis + self-heal demands; this is the one
explicitly-deferred demand.

- [ ] **P3 — GAP E: secondary-error cause-ref tagging.** #1685 demand 3 asks that
  downstream cascade errors (CONNECTION_ENDED, lock-renewal-failed, No database
  connection) be tagged `secondary=true cause_ref=<root-incident-id>` so they can't
  masquerade as the root cause in logs. v0.42.12.0 deferred this: the now-self-
  identifying RSS watchdog exit (from #1735) plus the cause-ranked `doctor` header
  (this wave, GAP C) already remove most of the symptom-masquerades-as-cause problem
  at the doctor surface. The remaining gap is the raw worker LOG stream during a live
  incident (not the doctor summary). Doing it right needs an incident-id correlator
  threaded through the supervisor + DB-error paths — a bigger change than the doctor-
  surface fixes this wave shipped. Pick up if live-log triage during an incident is
  still painful after operators have the cause-ranked doctor.
- [ ] **P3 — `worker_oom_loop` remote/thin-client path.** The bare-worker half of the
  OOM signal reads `minion_jobs` directly (Postgres-only, local). The HTTP MCP
  thin-client doctor path (`doctorReportRemote`) doesn't surface it. Same brain-wide-
  vs-source-scoping caveat noted inline at autopilot.ts (the `--source` remote scoping
  is a separate TODO, mirroring orphan_ratio). Wire once the thin-client doctor grows
  a supervisor/queue surface.

## v0.42.15.0 isTTY-output follow-ups (v0.42+)

Filed from the v0.42.15.0 wave (#1784, decouple primary output from
`process.stdout.isTTY`). Both are the same axis-conflation class the wave fixed
but were deliberately scoped OUT — neither is a #1784 regression.

- [ ] **P2 — `sync.ts:2491` emits a JSON cost-refusal even without `--json`.** The
  `gbrain sync --all` cost gate has the byte-identical pattern that
  `reindex-code.ts:457` had before #1784: non-TTY or `--json` → JSON envelope +
  exit 2, conflating "refuse to spend" with "machine-readable output." The
  refusal should be human text unless `--json` is explicit. Out of scope for
  #1784 because the sync cost-gate is documented as intentional in CLAUDE.md and
  deserves its own deliberate change. Fix: mirror the extracted
  `buildCostRefusal({json, ...})` helper (`reindex-code.ts`). The guardrail
  (exit 2, no spend) stays; only the FORMAT splits on `--json`.
- [x] **P3 — `gbrain jobs --help` has no subcommand list.** jobs.ts dispatches
  on a bare subcommand string with no HELP const, so `watch` (and every other
  jobs subcommand) is undocumented in `--help`. The new `watch` `--json` /
  `--follow` flags are documented only in the file JSDoc. Add a HELP table to the
  `jobs` command listing every subcommand + its flags.
  **Completed:** v0.45.15.0 (2026-08-14) — JOBS_HELP + JOBS_SUBCOMMAND_HELP with a
  guard above the thin-client refusal; `jobs`/`jobs work` etc. `--help` print real
  usage engine-free and can never start a daemon.

## v0.42.12.0 self-upgrade follow-ups (v0.43+)

Filed from the self-upgrading-gbrain wave. All deliberately scoped OUT (D7a/D7b
+ eng-review notes); none is a v0.42.12.0 regression. Plan + reviews at
`~/.claude/plans/system-instruction-you-are-working-nifty-badger.md`.

- [x] **P2 — Signature/checksum verification before applying an auto-upgrade
  (D7a).** **Completed:** v0.46.12.3 (2026-08-16). `verifyIntegrity` in
  `src/core/binary-self-update.ts` now checks the downloaded asset's SHA-256 +
  builder identity against the GitHub build-provenance attestation (already
  published by release.yml's `attest-build-provenance`) BEFORE chmod/exec/rename
  — fail-closed with typed `integrity_failed`/`integrity_unavailable`. No new
  release asset needed. Residual (from-source/`latest-stable` install paths) is
  re-filed as the P3 entry at the top of this file.
- [ ] **P2 — `gbrain serve` host graceful request-drain on auto-upgrade (D7b).**
  The silent channel currently skips while any request/stream/job/tx is in
  flight and retries next window. A true drain (stop accepting new, finish
  in-flight, swap, relaunch) is cleaner for a busy multi-tenant serve host.
- [ ] **P3 — Windows `binary` self-update.** Can't rename over a running `.exe`;
  no Windows release asset is published. Currently degrades to notify-only via
  `resolvePlatformAsset` returning null. Revisit if a Windows binary ships.
- [ ] **P3 — True binary rollback.** Today a bad release is caught by the
  post-swap `gbrain doctor` gate + recorded in `self_upgrade.failed_versions`
  (never retried) + a loud nudge. There is no automatic revert to the prior
  binary. A keep-N-prior-binaries rollback is a possible follow-up.

## v0.42.9.0 SkillOpt eval-readiness follow-ups (v0.42+)

Deferred from the v0.42.9.0 wave (held-out gate wiring + ENFORCE + ablation opts).
Adversarial-review findings that are real but not blockers — the shipped fixes are
complete and tested; these are hardening/cleanup.

- [ ] **P2 — Extract `promoteCandidate` helper (DRY).** The candidate-promotion
  sequence (optional `runHeldOutGate` → branch on `mutateDecision.mutate` →
  `acceptCandidate` else `writeProposed` → set outcome/finalText) is duplicated between
  the one-shot-rewrite block and the main loop accept branch in
  `src/core/skillopt/orchestrator.ts`. A future change to the held-out gate or promotion
  policy must be applied in two places. Extract a shared `promoteCandidate({...})`. Deferred
  this wave to avoid a >20-line refactor of freshly-tested accept-path code.
- [ ] **P2 — Harden bundled-skill detection.** `getBundledSkillContext`
  (`src/core/skillopt/bundled-skill-gate.ts`) only sets `isBundled` when the skills dir was
  resolved via the `install_path` tier. If the same bundled `skills/` is found via
  `cwd_walk_up` / `repo_root` / `$GBRAIN_SKILLS_DIR`, `isBundled=false` and the D16 ENFORCE
  never fires (same weakness governs `--allow-mutate-bundled` itself — pre-existing, not a
  v0.42.9.0 regression). Fix: compare realpaths against the canonical bundled skills dir
  independent of detection source.
- [ ] **P3 — Preflight cost estimate is blind to ablation opts.** `preflight.ts:estimateCost`
  doesn't know `optimizerMode`/`disableValidationGate`/`reflectMode`, so `--dry-run`
  over-counts for `one-shot-rewrite` / `failure-only`. Low impact (eval-internal knobs;
  runtime BudgetTracker enforcement is correct, no overspend) — just a lying preview.
- [ ] **P3 — `maxRuntimeMin` is enforced only between optimization steps.** The baseline
  eval, per-step held-out gate, one-shot rewrite, and final-test `scoreSkillOnTasks` calls
  run unbounded LLM rollouts with no deadline check. BudgetTracker still caps spend; the
  runtime guarantee is best-effort. Thread the deadline + abortSignal into those phases, or
  document runtime as best-effort.

## v0.42.7.0 extract-in-default-loop follow-ups (v0.42+)

Filed from the v0.42.2.0 wave (#1696 link/timeline extraction freshness
watermark). Both surfaced by the Codex review (P1-D, P1-C) and deliberately
scoped OUT — neither is a #1696 regression. See plan + GSTACK REVIEW REPORT at
`~/.claude/plans/system-instruction-you-are-working-squishy-crayon.md`.

- [ ] **P2 — Repo-wide: `DROP INDEX CONCURRENTLY` inside a `DO $$` block is
  Postgres-invalid.** `CONCURRENTLY` cannot run inside a transaction, and a `DO`
  block IS a transaction — so the invalid-index pre-drop guard throws
  `cannot run inside a transaction block` IF the branch ever fires (only on a
  retry after a prior failed concurrent build). Migration v112
  (`pages_links_extracted_at`) copies this pattern verbatim from shipped
  precedent: `idx_pages_updated_at_desc` (migrate.ts:~502),
  `pages_deleted_at_purge_idx` (~1619), `pages_coalesce_date_idx` (~1967). It is
  latent (the IF-EXISTS check returns false on a clean build → EXECUTE never
  runs) and has never been hit in production. Fix repo-wide in ONE sweep: replace
  each `DO $$ ... EXECUTE 'DROP INDEX CONCURRENTLY ...'` with a plain top-level
  `SELECT indisvalid` probe + a bare top-level `DROP INDEX CONCURRENTLY IF EXISTS`
  statement (the migration runner already runs these `transaction: false`). Do
  NOT single out v112 — fixing one diverges from the precedent; sweep all of them
  together with a shared helper. Needs its own review (touches every CONCURRENTLY
  migration).
- [ ] **P3 — Add-only extraction never deletes obsolete edges; the watermark now
  asserts a currency it can't fully deliver.** All gbrain extraction is add-only
  (`addLinksBatch` ON CONFLICT DO NOTHING, inline sync + `extractLinksFromDB` +
  `extract --stale`). A page edit that REMOVES a link adds nothing and never
  deletes the now-absent edge, yet `links_extracted_at` marks the page current,
  so `gbrain doctor` reports OK while the graph carries a stale edge. Pre-existing
  architectural property (not new in #1696), but the watermark makes it more
  visible. Real fix needs a link-provenance column (`link_source` / extracted-by
  marker) so a re-extract can safely DELETE extracted-but-now-absent edges for a
  page+source without clobbering manually-added or auto-link edges — mirrors the
  v0.41.37.0 tag-provenance deferral (#1621-followup). Defer until that column
  lands; until then `extract --stale` is reconcile-add-only by design.
## v0.42.5.0 watchdog / pooler-reap / lens-backlog follow-ups (v0.42+)

Deferred from the v0.42.5.0 wave (issue #1678). The shipped fixes are complete
and tested; these are documented tradeoffs and stronger-but-bigger versions.

- [ ] **P2 — `claim` idempotent recovery.** v0.42.5.0 deliberately does NOT
  inline-retry `claim` (a retry after the `UPDATE...RETURNING` committed but the
  socket died could double-claim a job); instead the worker poll loop reconnects
  and re-claims on the next tick. Codex independently flagged the residual: if
  claim's UPDATE commits but the connection dies before `RETURNING` reaches the
  worker, that job is `active` in the DB but absent from `inFlight` (orphaned). It
  is NOT lost — the stall detector reclaims it once `lock_until` expires (~one
  lock-duration + stall-interval, ~60s) and requeues it (stalled_counter 0 → first
  stall requeues, not dead-letters). The stronger fix: after a reconnect, look up
  an active job already holding this worker's `lock_token` before claiming a new
  one, so the orphan is recovered immediately instead of after a stall cycle.
  Needs the claim path to thread the lock_token through recovery.
- [ ] **P3 — `dream --drain` PGLite lock-path parity.** The drain takes the DB
  refreshing lock (`cycleLockIdFor`), which is the correct lock the routine cycle
  uses on Postgres. On PGLite the routine cycle uses the global FILE lock instead,
  so the drain's DB lock doesn't contend with it. This is currently moot because
  PGLite's exclusive single-process file lock means a separate `gbrain dream
  --drain` process can't even open the brain while autopilot's `gbrain dream`
  holds it (one fails at connect). If PGLite ever gains multi-handle access,
  the drain must also acquire the cycle file lock. Codex-flagged; low risk today.
- [ ] **P2 — `synthesize_concepts_backlog` doctor check.** The `extract_atoms`
  backlog check shipped; `synthesize_concepts` did not, because that phase is a
  stub with no real eligibility predicate (a NOT-EXISTS analog to atom
  `source_hash`). Add the check once the phase has a concrete "what's left"
  definition, else it's a fake signal.
- [ ] **P3 — `renewLock` AbortSignal-bounded retry.** The renewal tick recovers
  via a bounded reconnect-once + postgres.js auto-reconnect + multi-tick grace,
  NOT a `withRetry` around `renewLock` (which would race the tick's own timeout
  and could refresh a lock after another worker reclaimed it). If production shows
  the multi-tick grace is insufficient under sustained pooler churn, add an
  abort-aligned bounded retry under `callTimeoutMs`.
- [ ] **P3 — Waiter-flag cooperative lock.** The `--drain` mode uses a single
  bounded lock hold (autopilot defers for the window) rather than a
  release/reacquire-between-windows protocol with a `wants_lock` signal column.
  Tighter interleaving (autopilot preempts a long drain mid-window) would need
  that protocol + a migration; deferred as not worth the surface for the bounded
  window the drain already provides.
- [ ] **P3 — `cycle.force_phases` config.** No config to force a pack-gated phase
  (e.g. `extract_atoms`) to run inside the routine 5-min cycle. The `--drain`
  escape hatch + doctor warning cover the operator need; a config override would
  let the routine cycle run an expensive lens phase every tick (the reason it's
  pack-gated). Add only if a real workflow needs it.
- [ ] **P3 — Full per-job-kind RSS peak tracking.** The watchdog logs peak RSS +
  the in-flight job kind on the drain line and the 80% soft-warn, but doesn't
  persist per-job-kind peaks to an audit file or surface "embed-backfill peaked at
  9.8GB, cap 8GB" in doctor. Add persisted tracking + a doctor check if operators
  want trend visibility rather than the point-in-time log line.

## v0.42.2.0 gbrain connect follow-ups (v0.42+)

- [ ] **T6 (P3): `gbrain connect --env-token` form.** Ship the env-var-indirection
  token form (`-H 'Authorization: Bearer ${GBRAIN_REMOTE_TOKEN}'`, single-quoted so
  the shell doesn't pre-expand) ONLY after verifying that Claude Code actually expands
  `${VAR}` inside a stored `-H` header at runtime. v0.42.2.0 deliberately ships the
  literal-token default (matches the shipped docs, verified to work) because the
  env-default was unverified — the shell expands `${...}` before `claude mcp add`
  stores it, so it would have stored the literal token anyway. Verify CC behavior
  first, then add the opt-in flag. Files: `src/commands/connect.ts` (token-form),
  `docs/mcp/CLAUDE_CODE.md`.
- [ ] **T7 (P3): Tier 2 — local thin-client over a bearer token.** `gbrain connect`
  today only wires the MCP *connection* (Claude Code talks straight to the remote /mcp).
  The local `gbrain` CLI (`gbrain search`, `gbrain remote ping/doctor`, routed ops) still
  requires OAuth client-credentials — `remote_mcp` + `callRemoteTool`/`getAccessToken`
  in `src/core/mcp-client.ts` are OAuth-only. To let the local CLI work against the
  remote with just a bearer token, widen `remote_mcp` with a bearer path (`auth: 'bearer'`,
  `bearer_token`), short-circuit `getAccessToken` when `auth === 'bearer'` (skip discovery +
  /token mint), and teach `initRemoteMcp` (`src/commands/init.ts`) to write a bearer-shaped
  config. Then `gbrain connect --install` can also `bun install -g` gbrain + write the config.
  Deferred per D1 (Tier 1 only this release).

## v0.41.38.0 dream-postgres / source-pin follow-ups (v0.42+)

Deferred from the v0.41.38.0 wave (code-callers/callees pin + dream-on-postgres).
Documented tradeoffs, not blockers — the shipped bug fixes are complete and tested.

- [x] **P1 — Per-source autopilot fan-out passes the global repoPath.**
  **Completed (verified already fixed):** v0.45.15.0 audit (2026-08-14) — the
  handler binds FS phases to the source's `local_path` and never falls through
  to the global repoPath (`effectiveBrainDir = sourceId ? sourceLocalPath :
  repoPath` in src/commands/jobs.ts, with per-source null → skip FS phases).
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

> **#2180 update (v0.43+ brain-resident skillpacks + advisor):** brain-resident
> pack DISCOVERY over MCP shipped as a dedicated, source-scoped
> `list_brain_skillpack` op (NOT folded into `list_skills` — the host catalog is
> host-global and ignores `ctx.sourceId`, so per-source packs needed their own
> tenancy-correct surface). `get_skill` gained an optional `source_id` for
> per-source fetch disambiguation. The `tools:` version-skew lint below is now
> implemented (`src/core/skillpack/brain-pack-lint.ts`, run by
> `gbrain skillpack init-brain-pack`). STILL DEFERRED to this PR2: thin-client
> BINARY install (`build_skillpack` download) — a thin client today gets the
> pack's git scaffold spec and `resolveSource`s it on its own machine. The
> `include_skillpacks` host-global merge below is intentionally still open
> (separate concern from per-source brain packs).

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
- [x] **v0.42+: fold adaptive-return params into KNOBS_HASH so adaptive-on calls can cache.** **Completed: v0.48.0.0 (2026-09-01)** — same change as the write-path E5 entry (KNOBS_HASH v=27). v0.41.33.0 skips `hybridSearchCached` entirely when the gate is on (cache-safe but cache-cold). Fold `adaptive_return` enabled + caps + `minKeep` into `knobsHash()` (append-only, bump `KNOBS_HASH_VERSION`) so a gate-on write segregates from a gate-off row and adaptive calls cache correctly. Required before any default flip (else default-on means cache-cold everywhere). See `src/core/search/mode.ts` KNOBS_HASH parts + `return-policy.ts`. Priority: P2 (paired with the default-flip ablation above).
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

- [ ] **Non-Anthropic budget-tracker pricing.** PARTIALLY ADDRESSED by v0.42.25.0: `src/core/model-pricing.ts` is now the canonical multi-provider table (OpenAI / Google / Together / DeepSeek entries exist alongside Anthropic), and cross-modal-eval + takes-quality already price non-Anthropic models from it. REMAINING: `src/core/budget/budget-tracker.ts:lookupPricing` still routes only through the bare-keyed `ANTHROPIC_PRICING` view, so brainstorm + LSD users running budget gates against OpenAI / Gemini / OpenRouter still get `BUDGET_TRACKER_NO_PRICING` warn-once + bypass-gate (without `--max-cost`) OR `no_pricing` hard-fail (with `--max-cost`). Right fix: route `lookupPricing` through `canonicalLookup`. OpenRouter stays a special case (period-vs-dash key mismatch: their `claude-sonnet-4.6` won't match our `claude-sonnet-4-6`, and it intentionally misses to avoid pricing markup as native). Files: `src/core/budget/budget-tracker.ts`, `src/core/model-pricing.ts`. Priority: P2 (real user pain when running brainstorm against non-Anthropic).

- [x] **Eval-contradictions duplicate ANTHROPIC_PRICING consolidation.** **Completed:** v0.42.25.0 (2026-06-03). Deleted the local duplicate table in `src/core/eval-contradictions/cost-tracker.ts`; it now imports the canonical-derived `ANTHROPIC_PRICING` view and `pricingFor` preserves the silent-Haiku fallback (pinned by `test/eval-contradictions/cost-tracker-slash.test.ts`). Closed as part of the wider model-pricing unification.

## v0.42.25.0 pricing-unification follow-ups (v0.42+)

Filed from the v0.42.25.0 ship review (Claude + Codex adversarial + pre-landing).
All latent / hardening — none are user-reported bugs. The unification landed a
single canonical `src/core/model-pricing.ts` with `canonicalLookup`.

- [x] **`canonicalLookup` is case-sensitive (silent-miss undercount).** **Completed:** #4123 fix wave (2026-08-16). `canonicalLookup` now falls back to a case-insensitive lookup folding BOTH sides (a lazily-built lowercased view of `CANONICAL_PRICING` — some canonical keys carry cased model tails verbatim, so folding only the probe would have created the mirror-image miss). Exact matches stay first; mixed-case tests + a no-case-collision guard pinned in `test/model-pricing.test.ts`.

- [ ] **takes-quality `getPricing` is exact-key only.** `src/core/takes-quality-eval/pricing.ts:getPricing` does a raw `MODEL_PRICING[modelId]` lookup. A user passing a bare/slash/dotted form of an allowlisted model (e.g. `google:gemini-2.0-flash` when the allowlist holds `google:gemini-2-flash`, or `anthropic/claude-opus-4-8`) hits `PricingNotFoundError` even though canonical prices it. Safe direction (fail-closed) but a usability regression. Fix: normalize the lookup key through `canonicalLookup`/`splitProviderModelId` before the allowlist check, keeping fail-closed for genuinely-unsupported models. Priority: P3.

- [ ] **No negative-path test for the takes-quality module-load throw.** `src/core/takes-quality-eval/pricing.ts` throws at import if a `SUPPORTED_MODELS` id is absent from canonical (good fail-fast), but nothing tests it (awkward to test a module-load-time throw in-process). Add a small harness/fixture test. Priority: P3 (programmer-error guard).

- [ ] **Recipe display-layer pricing is stale and unconsolidated.** Each `src/core/ai/recipes/*.ts` carries coarse per-provider `cost_per_1m_input_usd`/`cost_per_1m_output_usd` baselines (e.g. `google.ts` chat = `$0.30/$1.20`, `price_last_verified: 2026-04-20`) read only by `gbrain providers` for display — NOT by any budget gate. They've drifted (google chat baseline predates the Gemini 2.0 Flash `$0.10/$0.40` reconciliation; codex flagged OpenAI baselines too). These are intentionally a separate coarse layer from the per-model `model-pricing.ts` budget tables, so consolidating is non-trivial (one-number-per-provider vs per-model). Options: (a) refresh the `price_last_verified` baselines, or (b) have `gbrain providers` show per-model rates from canonical where available and fall back to the recipe baseline. Flagged by the v0.42.25.0 ship Codex adversarial pass. Priority: P3 (display-only, no budget-gating impact).

## v0.41.21.0 ops-fix-wave follow-ups (v0.41.22+)

- **TODO-OPS-1 (P2)**: `gbrain sync print-cron` subcommand. Print the canonical
  cron line based on the active source set: `gbrain sync --all --parallel N
  --workers N --skip-failed` where N defaults to `min(sourceCount, 4)`. Reads
  `sources` table for active (non-archived, `local_path IS NOT NULL`) entries.
  Ergonomic upgrade over the v0.41.19.0 `sync_consolidation` doctor message —
  operator pipes directly into `crontab -e` instead of copy-paste-massage.
  ~80 LOC. Mirrors `gbrain sync --break-lock` argv shape.

- [x] **TODO-OPS-2 (P2)**: Lock-loss detection — CLOSED by the W0 fix-wave
  (code-smell series). `refresh()` now runs a FENCED update (id + holder_pid +
  epoch-rendered `acquired_at`) with `RETURNING id`, returns `false` on 0
  rows, and runCycle's steal controller aborts the run at the next boundary
  with a structured `reason: 'lock_stolen'` partial report (LockStolenError;
  raced awaits cover the 5 long phases). The supervisor exits LOCK_LOST
  immediately on a fenced miss. Pinned by `test/db-lock-fencing.test.ts` +
  `test/cycle-lock-steal.serial.test.ts`.

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
  **Status (test-gap wave): the INSTRUMENT is shipped** — evals/takes-bootstrap/
  (123-case deterministic corpus with empty/attribution/adversarial precision
  classes, scorer v1 with per-kind precision ≥0.80 / recall ≥0.70 and
  malformed-is-failure, live harness driving the real extractTakesFromPages
  path + $0 replay mode), keyless-CI-guarded by test/eval-takes-bootstrap.test.ts.
  The tier flip still requires a GRADUATED live run committed with its
  predictions JSONL per evals/takes-bootstrap/README.md — needs a chat key,
  ~123 Haiku-class calls.

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

- [x] **P1 flake — audit-writer.test.ts week-boundary failure.** DONE — both
  halves of the prescribed move already landed: src half in `ca68633f`
  (`fileDate` derived from the event's own `ts`, not wall-clock, at
  `src/core/audit/audit-writer.ts` computeFilename call site) and test half
  in `0b7efd35` (the hardcoded `2026-05-22` replaced with real `now` + direct
  week-file writes). The remaining Monday-straddle case works BECAUSE of the
  src fix (a Sunday `ts` routes to the previous week's file, which
  readRecent's two-file walk covers). Original filing: Caught
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
  CC ~3 hours. SCOPE NARROWED (v0.47.x fix wave): the single-oversized-chunk
  branch is now healed in place by `src/core/embed-oversize-heal.ts`
  (split-on-detect, shared by CLI embed + embed --stale), so that case no
  longer perma-fails a stale sweep; remaining scope is batch-overflow /
  token-estimate-miss + `TokenLimitError` quarantine.

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

- [x] **P0 — Wire nightly quality probe into autopilot scheduler.** DONE —
  and this entry was STALE when the v0.46.15 wave audited it: autopilot's
  tick body already invokes `runNightlyQualityProbe` behind the
  `autopilot.nightly_quality_probe.enabled` gate
  (`src/commands/autopilot.ts:1361-1386`, pinned by
  `test/autopilot-nightly-probe-wiring.test.ts`). Nothing to build.

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

- [x] **Retrofit `awaitPendingSearchCacheWrites` with a bounded timeout.**
  DONE in v0.42.20.0 (#1762 reliability wave): `awaitPendingSearchCacheWrites`
  is now bounded (`Promise.race` + leftover count), matching
  `awaitPendingLastRetrievedWrites`.

- [x] **Extract a shared drain abstraction once a third fire-and-forget surface
  appears.** DONE in v0.42.20.0: rule-of-four was met (last-retrieved, facts,
  search-cache, eval-capture), so `src/core/background-work.ts` (a registry, not
  a per-surface factory) is the single drain owner; each sink registers a
  drainer and CLI exit calls `drainAllBackgroundWorkForCliExit`.

- [ ] **(v0.42.20.0 follow-up) Convert `runSync`'s ~20 internal `process.exit`
  sites to `exitCode + return`.** Today those error/cost-gate paths skip the
  background-work drain + graceful disconnect (they avoid the #1762 hang by
  skipping disconnect entirely; worst case is a transient PGLite stale-lock that
  self-heals via stale-reclaim). The common sync SUCCESS path already drains via
  handleCliOnly's finally. Convert for graceful drain on sync error exits.

- [ ] **(v0.42.20.0 follow-up) Gateway idle-timeout (vs absolute) for streaming
  chat.** `withDefaultTimeout` uses an absolute `AbortSignal.timeout`; a streaming
  generation actively producing tokens past the chat default (300s) would abort.
  Non-streaming `generateText` makes this low-risk today; revisit if a real
  long-stream caller trips it.

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
  commit to the sibling gbrain-evals repo. PARTIALLY SUPERSEDED by the test/eval/CI
  speedup pass: an in-repo canonical qrels target now exists (`gbrain eval gate`
  with the deterministic embedder option against `test/fixtures/eval-baselines/
  qrels-search.json`; runner `scripts/run-eval-canary.ts`, CI-gated via
  `test/eval-canary.test.ts` in the unit matrix with `check:eval-canary` as
  the on-demand package script, ledger `.gbrain-evals/eval-results.jsonl`). What remains
  here is only the sibling-repo REGRESSION baseline (.baseline.ndjson for the
  jaccard/top1 gate) — the correctness-gate half is done.

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

- [x] **v0.41+: T20 — extends-chain merging in registry.ts.** DONE (#1749).
  `resolvePack` now merges parent → child (child-wins) for the six
  ingest/query-shaping fields (`page_types`, `link_types`,
  `frontmatter_links`, `enrichable_types`, `filing_rules`, `takes_kinds`)
  plus `borrow_from` materialization, in `src/core/schema-pack/merge.ts`.
  The cascade was transparent (consumers already read `resolved.manifest`),
  not per-consumer. `phases`/`calibration_domains` deliberately excluded —
  see the P3 follow-up below.

- [ ] **P3: explicit opt-in to inherit `phases` / `calibration_domains`.**
  T20 excludes these two from the child-wins merge because they gate real
  cycle execution (`cycle.ts` `packDeclaresPhase`) and the manifest
  contract says each pack declares its own participation explicitly —
  auto-inheriting would silently make a child run cycle phases it never
  requested. Multi-level lens packs (`gbrain-everything`) therefore still
  re-declare them by hand. If that redeclaration becomes painful, add an
  explicit manifest flag (e.g. `inherit_phases: true`) so a pack author
  opts in consciously. Depends on: T20 (landed). Start in
  `src/core/schema-pack/merge.ts` (`mergeInheritedManifest`).

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

- [ ] **v0.41+: drop the `--skip-failed` / `--retry-failed` + `--parallel > 1` restriction now that the failure log is source-scoped.**
  **Priority:** P3
  v0.42.32.0 (#1939) landed the source-scoping infrastructure this TODO asked
  for: `src/core/sync-failure-ledger.ts` keys every row by `(source_id, path)`,
  `recordFailures(sourceId, …)` stamps it, `acknowledgeFailures(sourceId)` /
  `autoSkipFailures(sourceId, …)` filter to one source, and a cross-process
  lock + atomic temp-rename (`withLedgerLock`) makes concurrent read-modify-write
  safe. The remaining work is just to LIFT the v0.40.3.0 interim guard at
  `src/commands/sync.ts:3078` (`parallelEligible && (skipFailed || retryFailed)`
  → loud refuse) after adding a test that proves source-scoped acks stay
  deterministic under `--all --parallel N`. Estimate: ~0.5 day. Originally filed
  during the v0.40.3.0 plan review (Codex outside-voice, decision D15 → B).

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
  `gateway.rerank()`'s own model-list check (rerank-specific; it validates the
  model exists before pricing fires — note this was never `assertTouchpoint`,
  which checks provider touchpoints only). Theoretical bypass: a future caller that
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

- [x] **v0.41+: Wire the nightly quality probe into autopilot scheduling.**
  DONE (stale entry swept by the v0.46.15 wave): autopilot's tick body
  invokes `runNightlyQualityProbe` behind the
  `autopilot.nightly_quality_probe.enabled` gate
  (`src/commands/autopilot.ts:1361-1386`, pinned by
  `test/autopilot-nightly-probe-wiring.test.ts`).
  Doctor surface is already in place to show outcomes; just need the
  scheduling lane. Estimate: ~3 hours.

## v0.41+ e2e-test-wave follow-ups (filed during v0.40.8.0 ship)

- [ ] **NEW-1 (P2) — Per-check leaf unit tests for the 20+ exported doctor check functions.** `src/commands/doctor.ts:169-1492` exports whoknowsHealthCheck, takesWeightGridCheck, childTableOrphansCheck, checkRerankerHealth, checkBrainstormHealth, checkSearchMode, checkEvalDrift, checkSyncFreshness, checkAbandonedThreads, checkCalibrationFreshness, checkGradeConfidenceDrift, checkVoiceGateHealth, checkZeEmbeddingHealth, checkEmbeddingWidthConsistency, checkSourceRoutingHealth, checkOauthConfidentialHealth, checkAutopilotLockScope, skillBrainFirstCheck. v0.40.8.0 covers them via the orchestrator only. Parameterize a single `test/doctor-leaves.test.ts` over the exported functions; each case seeds the minimum DB state and asserts the returned `Check.status`. Catches per-check render bugs the orchestrator snapshot can't see (codex CMT-2 deep fix). Estimated ~4h CC.
- [ ] **NEW-2 (P2) — Cycle-phase wrappers beyond lint + backlinks.** 7 more phases need result-mapping coverage: sync, extract, embed, orphans, extract_facts, resolve_symbol_edges, recompute_emotional_weight. Each adds a describe block to `test/cycle-legacy-phases.test.ts` following the established pattern. ~30min/phase with CC. Mechanical follow-through.
- [ ] **NEW-3 (P2) — HTTP-level trust-boundary test that proves serve-http.ts honors the filter at runtime.** v0.40.8.0 ships the source-grep guard at `scripts/check-operations-filter-bypass.sh` plus structural assertions in `test/operations-trust-boundary.test.ts`. The codex CMT-3 strongest defense — runtime proof that a register-OAuth-client → attempt-call-every-localOnly-op flow rejects every one — would extend `test/e2e/serve-http-oauth.test.ts`. Real Postgres dep, ~30s wallclock per case. Closes the bypass class with runtime proof in addition to the existing structural defense.
- [ ] **NEW-4 (P3) — Render function extraction from runDoctor.** v0.40.8.0 uses a subprocess smoke at `test/doctor-cli-smoke.serial.test.ts` to cover the wrapper's render + exit paths. Pulling the human + JSON render code out into pure formatters would let that smoke move back into the parallel fast loop with no subprocess overhead. ~2h CC. Lower priority — the subprocess smoke does its job; this is a wallclock win, not a coverage win.

## v0.41+ master flake follow-ups (filed during v0.40.8.0 ship)

- [x] **(P3) — Audit other gateway-mutating tests for missing afterAll cleanup.** DONE (stale as originally written + swept): the two named files already carry cleanup (`test/ai/rerank.test.ts` afterEach→resetGateway; `test/gateway-embed-model-override.test.ts` beforeEach/afterEach→resetGateway). The one live instance found by a fresh sweep — `test/ambient-recall.test.ts` configuring a keyless gateway with no reset anywhere — gained `afterAll(() => resetGateway())` in the test-infra perf wave.
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

- [x] **`test/search/embedding-column.test.ts:466,489,522` — `isCacheSafe` returns false when run after gateway-state-mutating siblings in shard 2.** DONE: closed by option (c) — the file was renamed to `test/search/embedding-column.serial.test.ts` in `ca68633f` (v0.41.2.0), giving it its own bun process; entry left open pointed at a filename that no longer exists. If the file is ever un-quarantined, add `beforeEach(() => resetGateway())` (NOT `__unconfigureGatewayForTests` — that falls through to the ZE/1280 defaults; `resetGateway` re-applies the preload's OpenAI/1536 baseline). Original filing: Confirmed pre-existing on master (`git stash` + `SHARD=2/8 bash scripts/run-unit-shard.sh` reproduces 3 fails on a clean working tree). Symptom: `isCacheSafe(default-named-column, empty-cfg)` expects `gwDims=1536` but reads `1280` (the post-v0.37.11.0 ZeroEntropy default). Some test in the shard before embedding-column.test.ts initializes the gateway with the PGLite-default ZeroEntropy/1280 config and leaves it that way. Either: (a) embedding-column.test.ts grows a `beforeEach` that calls `__setEmbedTransportForTests`-style reset, (b) the offending sibling adds an `afterAll(reset)`, or (c) embedding-column.test.ts becomes `*.serial.test.ts` to quarantine. Three test files in shard 2 touch gateway state via PGLite engine connects: `restart-sweep.test.ts`, `init-mode-picker.test.ts`, `doctor.test.ts`. Tests pass in isolation (50/50); only fail under shard-2 ordering. v0.40.4 ships through this flake — not introduced by the wave.

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

- [x] **OpenRouter Anthropic subagent loop.** Anthropic routes (`openrouter:anthropic/…`) now declare `supports_subagent_loop` via a per-id predicate. `isAnthropicProvider` stays false (Messages SDK cannot speak OR); the handler auto-routes those jobs through `gateway.toolLoop()` when `agent.use_gateway_loop` is off. Live abort/retry: `test/e2e/openrouter-anthropic-subagent-replay.live.test.ts` (skip-gated on `OPENROUTER_API_KEY`). Other OR families stay refused.

- [x] **DeepSeek DONE (v0.48.1.0 wave, #4672): Live-test non-Anthropic OpenRouter families for the subagent loop.** DeepSeek routes now drive the subagent loop with a live abort/retry pin (`test/e2e/openrouter-deepseek-subagent-replay.live.test.ts`); supported families are declared once in `src/core/ai/openrouter-families.ts`. REMAINING: OpenAI / Gemini families stay refused until each gets the same abort/retry pin before the predicate widens further.

- [ ] **v0.37.x: Quarterly OR catalog refresh.** v0.37.6.0 ships 8 curated chat slugs (gpt-5.2, gpt-5.2-chat, gpt-5.5, claude-haiku-4.5, claude-sonnet-4.6, claude-opus-4.7, gemini-3-flash-preview, deepseek-chat) with `price_last_verified: '2026-05-20'`. OR's catalog churns weekly; specific slugs get deprecated, renamed, or merged. Refresh cadence: every 90 days, walk https://openrouter.ai/models, prune deprecated slugs, add new frontier IDs that match the recipe's curation logic (frontier-tier + cheap-routing entry points). Bump `price_last_verified`. The shape-test regression in `test/ai/recipe-openrouter.test.ts` (`MODEL_SHAPE` regex) means typos surface immediately; the catalog refresh is about discovery, not validation.

- [ ] **v0.37.x: Adopt `resolveDefaultHeaders` for Together / Groq / other attribution-bearing recipes.** v0.37.6.0's `default_headers` / `resolveDefaultHeaders` seam is generic — any recipe whose provider benefits from app-attribution headers can opt in. Together and Groq both have rankings/analytics tied to per-app headers. Add their respective attribution headers to each recipe, similar to OR's `HTTP-Referer` + `X-OpenRouter-Title`. No type-system or gateway changes needed; just `default_headers` blocks on the existing recipes plus `<PROVIDER>_REFERER` / `<PROVIDER>_TITLE` env vars in their `auth_env.optional`. Filed during v0.37.6.0 eng review as a D4 generalization opportunity.

- [x] **v0.37.x: Guard cli.ts `main()` so importing `buildGatewayConfig` doesn't print help.** v0.37.6.0 exported `buildGatewayConfig` from `src/cli.ts` for test access. Importing it triggers the file's top-level `main()` which prints help to stdout during tests — functionally harmless (tests pass) but noisy. Fix: wrap `main()` in `if (import.meta.main)` so it only runs when cli.ts is the entry point, not when imported. Touches one line; trivial. Filed during v0.37.6.0 implementation.


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

- [x] **v0.34.x: Source-scope `takes_*` ops (pre-existing leak surfaced during v0.34.1 adversarial review).** DONE — verified already fixed and pinned on `garrytan/cathedral-6`: all four `takes_*` ops route through `sourceScopeOpts(ctx)` at `src/core/ops/takes.ts:30/57/86/113`.

- [ ] **v0.34.x: Extend `sourceScopeOpts(ctx)` to the remaining read-side ops on the v0.31.8-era scalar pattern.** Most of the original list is fixed: `get_page`/`list_pages` route through `federatedSearchScope` (#3242), the four `takes_*` ops route through `sourceScopeOpts` (ops/takes.ts), and links/timeline-read/tag-set reads were converted (#2200). Still on `const sourceOpts = ctx.sourceId ? { sourceId: ctx.sourceId } : {}`: `ops/tags.ts:26,45`, `ops/timeline.ts:51`, `ops/raw-data.ts:27`, `ops/sync-status.ts:31`, `ops/admin.ts:158`, `ops/extraction.ts:83,187`, and `ops/pages.ts:252,775,808` (the pages.ts/extraction.ts arms are write-adjacent — audit each before switching; write authority is deliberately scalar). NOT a leak (scalar `ctx.sourceId` IS threaded), but federated_read (#876, `ctx.auth?.allowedSources`) is silently dropped on those reads.

- [ ] **v0.34.x: Migration v60 idempotency guard against `--force-retry` race with v64.** `gbrain apply-migrations --force-retry 58` after v64 has already run will re-install the FK with `ON DELETE SET NULL`, silently downgrading the v64 RESTRICT posture. Probability low (operator has to explicitly force-retry 58) but failure mode is invisible. Fix: v60 should probe `pg_constraint.confdeltype` before re-adding and refuse to clobber `'r'` (RESTRICT) with `'n'` (SET NULL).

- [ ] **v0.34.x: `embedMultimodalOpenAICompat` batching + partial-failure handling.** `src/core/ai/gateway.ts:1180-1255` sends one HTTP request per input. Multi-input callers (10 images) get 10 sequential round-trips with no parallelism; a 401 on input #5 throws and discards inputs #1-#4's already-computed embeddings (wasted spend, no surfacing of the partial array). Voyage's existing path batches. Fix: batch via the provider's `input: [...]` array shape; on partial failure, return successful embeddings + failed-index array.

- [ ] **v0.34.x: Doctor check `oauth_orphan_source_id`** — surfaces OAuth clients whose source_id was nulled by the v60 D10 silent-widen path (`GBRAIN_ACCEPT_SILENT_WIDEN=1`). Closes the observability gap from v0.34.1's D4 decision. Sibling to the `rls_event_trigger` check pattern in `src/commands/doctor.ts`.

- [x] **v0.34.x: `gbrain sources purge` FK error UX.** DONE on `garrytan/cathedral-6`: `clientsReferencingSource` + `formatClientReferentsBlock` in `src/core/destructive-guard.ts` pre-check remove/purge/auto-purge in `src/commands/sources.ts` and print the named-client refusal (revoke hint included) instead of the raw FK violation; `assessDestructiveImpact` carries `oauthClientCount`.

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

**Deferral note (CLI→MCP gap-closure wave, 2026-08-16, user decision D3A):**
deliberately NOT bundled into the gap-closure wave — there is no CLI to
mirror yet (this TODO is its own work item, not a CLI→MCP gap), and a token
that can mint its own successor turns a leaked credential into persistence +
operator lock-out, so it needs its own auth-plane design pass. Sketch agreed
at review: admin scope, NOT localOnly (remote rotation is the point),
SELF-rotation only (the calling token/client — never a name param), returns
the new secret exactly once, rate-limited via the RateLimiter house pattern,
and ships in the same PR as the `gbrain auth rotate` CLI.

**What:** Atomic rotate for legacy + OAuth tokens. Issue a new token in the same TX as the revocation of the old, no overlap window. Refresh-token rotation already exists for OAuth; this is the unified user-facing surface (CLI + MCP).

**Why:** Today rotation is `revoke + create`, with a window where neither token works. For long-lived bearer keys handed to agents, that's a reload outage every time the key gets rotated.

**Pros:** Single command does the right thing. Atomic cutover. Operators stop scripting around the gap.
**Cons:** Needs careful testing of the legacy `access_tokens` UPDATE path (returns single-use new token before the row mutates) plus an MCP op that grants a new token bound to the original client_id without requiring a new authorize round trip.
**Context:** Item 4 from the gstack /setup-gbrain v1.28.1.0 enhancement request. v0.28.x candidate.
**Depends on:** Nothing.

### Migration introspection in `get_health`
**Priority:** P3 — **DONE (CLI→MCP gap-closure wave, 2026-08-16).** The
`get_health` OP now returns `migrations {pending, partial, wedged,
skipped_future}` composed at the op layer from the new
`src/core/migration-ledger.ts` (version strings only). Op-layer composition
was chosen over this TODO's engine-method wording: the ledger is a
filesystem JSONL, engine-agnostic — growing `BrainEngine.getHealth()` would
have duplicated a file read in both engines. Pinned by
`test/migration-ledger.test.ts` + `test/get-job-stats-op.test.ts`'s sibling
patterns.

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
**Priority:** P3 (downgraded from P0 in the test/eval/CI speedup pass — premises stale:
the entry says "~58 PGLiteEngine instantiations", the suite now has 600+; the serial
quarantine grew from 4 files to ~140, and the pass's pooled serial runner + CI snapshot
+ verify pool delivered a comparable multiple for hours of work instead of the 1-2
weeks this sweep estimates. Re-scope against post-pass timing data before spending
anything here; `test.concurrent` adoption remains at zero.)
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

### ~~Hermes runner — `src/core/claw-test/runners/hermes.ts`~~ DONE (hermes-harness wave)
Shipped: `HermesRunner` (`hermes -z <brief>`, `$HERMES_BIN` > `which hermes`,
`HERMES_HOME` env-allowlist delta) + the full hermes install door
(`test/e2e/install-real-hermes.serial.test.ts`, opt-in-gated) + the label-gated
`hermes-door` CI job in heavy-tests.yml. The cross-agent
`gbrain friction diff --base openclaw --compare hermes` payoff shipped in the
same wave (below). Observed-CLI pins live in `docs/mcp/HERMES-CLI-PIN.md` and
`docs/mcp/HERMES.md`.

---

### Friction analytics suite — `trend` / `migration-stub` (diff SHIPPED)
**Priority:** P2

**What:** Two remaining `gbrain friction` subcommands deferred from v1
(`diff` shipped in the hermes-harness wave — see `src/commands/friction.ts`):
- `gbrain friction trend [--since <version-or-date>] [--phase <name>]` (time-series across runs; ~60 LOC)
- `gbrain friction migration-stub [--threshold N]` (clusters friction by phase + tokens, emits `skills/migrations/v[N+1].md` stub; ~150 LOC)

**Why:** Turns point-in-time reports into a slope. Pairs with the v1.1 public scoreboard.

**Effort:** M (CC ~1.5h total).

---

### Promote hermes-door soft probes to hard assertions + build the REAL cron test
**Priority:** P2

**What:** Two follow-ups now that the hermes CLI surface is pinned (v0.20.0,
`docs/mcp/HERMES-CLI-PIN.md`): (1) promote the door's logged-evidence probes
(`hermes mcp list` output shape; session-artifact tool-call traces under
`<home>/.hermes/`) to hard assertions once a couple of CI runs confirm their
stability across hermes releases; (2) build the real cron pairing test — the
surface is fully non-interactive (`hermes cron create [--name N] [--no-agent]
[--script PATH] <schedule> [prompt]` + `hermes cron tick` runs due jobs once
and exits) — create a job that runs `gbrain sync --json`, tick, and assert the
sync actually executed against the run's brain. (A self-skipping probe was
deliberately CUT in review: a test that cannot fail is not coverage.)

**Why:** INSTALL_FOR_AGENTS.md's recurring-jobs step has zero coverage; the
evidence sweep is the promotion signal the door already logs.

**Effort:** S-M (CC ~45m). Depends on: first labeled hermes-door CI runs.

---

### Wire the orphaned `voice-agent-install` ScenarioKind
**Priority:** P2

**Status (test-gap wave):** the guard half landed — test/scenarios.test.ts
now sweeps every shipped claw-test fixture (loads + coherence) and holds
`voice-agent-install` in a two-sided KNOWN_ORPHANS ratchet (must stay
well-formed AND keep failing to load), so landing this wiring forces the
ratchet entry out. The wiring itself remains open: claw-test's phase runner
branches only on `kind === 'upgrade'`, so a loader-only extension would run a
bogus fresh-install pass — land the loader + postInstallHook together.

**What:** `test/fixtures/claw-test-scenarios/voice-agent-install/` carries the
richest install-assertion template in the repo (60-line expected.json:
filesystem manifest, `.gbrain-source.json` sha256s, resolver rows, PII
blocklist, health probe, tiered soft-fail) but `scenario.json` declares
`kind: "voice-agent-install"`, which `ScenarioKind` rejects — the fixture
cannot load. Extend `ScenarioKind` + `loadScenario` + a `postInstallHook`
implementation so the scenario runs.

**Why:** Integrations-recipe install coverage (the `gbrain integrations
install` path) has a fully-designed scenario sitting dead.

**Effort:** M (CC ~1h). Integrations-lane work, deliberately kept out of the
hermes-harness wave.

---

### Cold-install container test — fill the `tests/docker/bootstrap-e2e.sh` placeholder
**Priority:** P3

**What:** heavy-tests.yml carries a gated no-op step for
`tests/docker/bootstrap-e2e.sh` (networkless cold-machine container install of
gbrain itself: global install, PATH discovery, migrations). The file doesn't
exist. Write it.

**Why:** The agent-platform door tests (claude/codex/hermes) all deliberately
run gbrain from the dev tree / compiled binary — none of them proves gbrain's
own cold install. That gap was re-flagged in the hermes-harness wave's outside
review and scoped OUT of that wave on purpose.

**Effort:** M (CC ~1-2h, docker).

---

### BrainBench hermes adapter
**Priority:** P3

**What:** ~50-100 lines in `src/eval/brainbench/adapters/hermes.ts` + an
`ALL_HARNESSES` entry + baseline cells in `evals/brainbench/baselines/main.json`.

**Why:** Cross-harness memory-conformance coverage for the third platform.
Eval seam (memory conformance), NOT install — kept out of the install wave on
purpose; needs baseline-governance care per the BrainBench gate rules.

**Effort:** S-M (CC ~1h + baseline runs).

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

**What:** The `upgrade-from-v0.18` scenario ships scaffolded — `seed/dump.sql` is missing. Both scripted and live runs now FAIL LOUDLY on the missing dump (a silent skip used to init a current database and false-green the "upgrade"), so the shipped scenario is unrunnable until the dump lands. Generate a real v0.18-shape PGLite dump per the procedure documented in `test/fixtures/claw-test-scenarios/upgrade-from-v0.18/seed/README.md`.

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

**What:** `transcript-capture.ts` currently uses plain `child_process.spawn` pipes. Some agents only emit ANSI colors / progress UI on a TTY. v1.1 adds a PTY mode so live-mode transcripts capture the full agent UX. Do NOT add node-pty for this: Bun's built-in `terminal:` spawn option (Bun 1.3.10+, already pinned in engines) is the dependency-free path, proven by `test/helpers/tty-harness.ts` — reuse `launchTty` or its spawn shape.

**Why:** Faithful transcripts make the friction → reasoning link more useful. v1 accepts that some agent UI is lost.

**Effort:** S (CC ~30m). Mostly a ~30 LOC swap inside `spawnWithCapture`.

---

### Non-tier-1 e2e files run in no required CI lane
**Priority:** P2

**What:** Unit shards exclude `test/e2e/*` (`scripts/test-shard.sh`), and `.github/workflows/e2e.yml` runs only explicitly named files (a handful across its jobs — e.g. `test/e2e/mechanical.test.ts`, `test/e2e/mcp.test.ts`, the jsonb-parity pair); there is no glob. Every other `test/e2e/*.test.ts` — including PGLite-only files that need no `DATABASE_URL`, like `init-fresh-pglite.test.ts` — executes only when someone runs `bun run test:e2e` by hand. Decide per file: wire into a required workflow, re-home PGLite-only files to the serial lane (the pattern `test/init-picker-pty.serial.test.ts` uses), or explicitly document them as manual-only.

**Why:** Tests that never run in required CI are silent coverage loss — they rot without failing. Surfaced by the TTY-harness cleanup review when the new PTY picker test almost landed in the same dead lane.

**Effort:** S-M (CC ~30-60m for the audit + re-homing; workflow wiring adds CI-minutes cost per file).

---

### Ctrl-D during `gbrain init` stalls 60s at the next prompt (readLineSafe does not latch EOF)
**Priority:** P2

**What:** Pressing Ctrl-D at the interactive provider picker is detected immediately (keyless fallback in ~200ms), but Bun's stdin never yields another line after EOF while `isTTY` stays true — so the SUBSEQUENT search-mode picker sits its full 60s `readLineSafe` fallback before init completes (probed under a real PTY: keyless notice at 0.2s, mode prompt rendered at 1.2s, exit at 61.1s). Fix: `readLineSafe` (src/commands/init.ts) should latch EOF — once stdin has ended, later calls return their default immediately instead of waiting out the timer. Regression test: extend the EOF case in `test/init-picker-pty.serial.test.ts` to run init to completion and assert exit well under the fallback window (the case currently closes early on purpose to keep the 60s stall out of required CI — see the comment there).

**Why:** A user who hits Ctrl-D at the first prompt stares at a frozen screen for a full minute before init finishes. Cross-model adversarial review finding (Codex), confirmed by a real-PTY probe.

**Effort:** S (CC ~20m: EOF latch + regression-test extension).

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

### ~~(v0.42.20.0 follow-up) Decouple the op-dispatch force-exit timer~~
**Completed:** v0.42.39.0 (2026-06-10)

The timer now arms at teardown entry (inside the op-dispatch finally, before
drain + disconnect) so it bounds ONLY disconnect — no longer doubling as a
blanket handler watchdog that killed slow-but-healthy ops at 10s with exit 0
and empty stdout. Its "engine.disconnect() did not return…" message is now
accurate by construction (it can only fire during teardown). Read-scope
handlers + context build got their own explicit wallclock bound (180s default,
`--timeout=Ns`, exit 124, hard-exit after teardown) in the same wave. Pinned by
`test/cli-force-exit-teardown-arming.test.ts`.

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

**Why:** Historically PGLite's WASM files couldn't be embedded in the compiled binary. STALE-PREMISE NOTE (#4116): "users who install via bun-global are fine (WASM resolves from node_modules)" turned out to be false — a bun-global UPGRADE hoists `@electric-sql/pglite` out of gbrain's node_modules and the repo-relative asset imports broke every command; fixed by `resolvePgliteAssetPaths()`'s tiered lookup. The compiled-binary half was separately fixed by the embedded-assets work (see the FIXED ledger entry guarded by `scripts/check-pglite-embedded.sh`). An upstream Bun fix would still simplify both lanes. Jarred Sumner (Bun founder, YC W22) would likely be receptive.

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
- **Broader operation-layer limit caps.** `traverse_graph` `depth` param, plus `get_chunks`, `get_links`, `get_backlinks`, `get_timeline`, `get_versions`, `get_raw_data`, `resolve_slugs` — all currently accept unbounded `limit`/`depth`. Wave 3 only clamped `list_pages` and `get_ingest_log`. _(partially addressed in v0.48.1.0: remote `traverse_graph` defaults to depth 2 and both engines cap the recursive walk at 5,000 rows; other ops still uncapped.)_
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

### Provider-symmetric early gate for `think --model` (#1698 follow-up, P3)

**What:** Make `runThink`'s explicit-`--model` early gate reject an explicit
NON-Anthropic model with no provider key BEFORE gather, not after. Today
`probeChatModel` (`src/core/ai/gateway.ts`) only pre-checks the Anthropic key;
non-Anthropic providers pass the early gate and hard-error at the create-callback
rethrow instead (one wasted retrieval gather). The deviation is documented as D1
in the #1698 fix and is **accept-as-is** — pinned by the "D1 backstop" test in
`test/think-gateway-adapter.test.ts` (build succeeds, `create()` throws).

**Why:** Symmetry — every explicit unusable model fails at one chokepoint, so the
"no silent degrade on explicit model" guarantee is provable in a single place
rather than relying on the create-callback backstop for non-Anthropic providers.
Saves one gather per failure in the rare explicit-non-Anthropic-no-key case.

**Pros:** single validation chokepoint; explicit > clever.
**Cons:** the obvious implementation (route `probeChatModel` onto the gateway's
`isAvailable` for all providers) carries an unconfigured-gateway false-reject
footgun — `isAvailable` returns `false` when `_config` is absent even if an env
key exists, which could false-reject a *usable* model in some test/unconfigured
paths. A correct version needs a config-independent provider-general key probe
(reads each recipe's auth resolver against env+config without the gateway's
runtime `_config`), plus the full targeted-test sweep to prove no regression
across the ~13 think tests + the non-explicit `tryBuildGatewayClient` build path.

**Context:** Surfaced by both the diff-level eng review (rated P3) and an
independent codex pass (rated P1) of the #1698 implementation. Severity tension
resolved accept-as-is: the safety property (no silent degrade on explicit unusable
model) is already met; this is a timing/symmetry improvement, not a safety fix.
Start at `probeChatModel` in `src/core/ai/gateway.ts` and the explicit gate in
`runThink` (`src/core/think/index.ts`).

**Depends on:** a config-independent provider-general key probe (new gateway
helper) so the `isAvailable` unconfigured-gateway false-reject footgun is avoided.

## v0.42.14.0 follow-ups (#1780)

### Unify the init live-test-embed with the models-doctor reachability probe
**Priority:** P3

**What:** `src/core/init-embed-check.ts:liveTestEmbed` and
`src/commands/models.ts:probeEmbeddingReachability` both do the same thing —
a 1-token `gateway.embed(['probe'], {inputType:'query', abortSignal})` with a 5s
timeout + error classification. They were left as two small implementations
because `probeEmbeddingReachability` is private and returns the doctor-shaped
`ProbeResult`, while the init path wants `{ok, reason, message}`.

**Why:** rule-of-three is met (init check + models doctor + the classifyError
duplication). One shared embed-probe core would prevent the two from drifting
on timeout/classification behavior.

**How to start:** extract the embed + AbortController-timeout + error-classify
core into a shared helper (e.g. `src/core/ai/embed-probe.ts`), have both
`liveTestEmbed` and `probeEmbeddingReachability` adapt its result to their
respective shapes. Small, mechanical; pinned by `test/init-embed-check.test.ts`
+ the models-doctor tests.

**Depends on:** nothing.

## Harness-mode follow-ups (#4043, filed at build time)

- [ ] **P2 — serve-side port/pid record for discovery.** `gbrain bootstrap harness`
  and its `--status` probe `/health` at 127.0.0.1:3131 (or an explicit `--url`/`--port`);
  a serve on a non-default port is invisible without flags. Write a record (port, pid,
  started_at) from `runServeHttp`'s `app.listen` callback into `~/.gbrain/run/`,
  mtime-as-heartbeat like `src/core/autopilot-paths.ts` — the stale-record semantics
  (crashed serve, multi-serve boxes) are why this deferred; a wrong record misdirecting
  probes is worse than no record. **Trigger:** a harness box running serve on a custom
  port asking why discovery misses it. **Start:** `src/commands/serve-http.ts` listen
  callback + `src/core/bootstrap/harness.ts` url resolution.
- [ ] **P3 — legacy HTTP transport scope asymmetry.** `src/mcp/http-transport.ts` is
  test-only (no production caller; `serve --http` uses serve-http.ts) and hardcodes
  `scopes: []` with no per-op scope gate — if it is ever revived, a scoped legacy token
  is fully UNSCOPED there. Mirror the `scopes TEXT[]` honor + `hasScope` dispatch gate
  before any revival. **Trigger:** any production caller of `startHttpTransport`.
- [ ] **P3 — partial unique index on active `access_tokens.name`.** Names are not
  unique; `auth revoke <name>` clears every active row and the 23505 handler in
  `auth create` is dead code for name collisions. Harness mode sidesteps this with
  revoke-by-id + receipt-carried ids, but a
  `CREATE UNIQUE INDEX ... ON access_tokens (name) WHERE revoked_at IS NULL` would
  make names honest for humans too. Needs a dedup pass first on brains that already
  carry twins. **Start:** `src/core/migrate.ts` (CONCURRENTLY + `transaction: false`).
- [x] **P2 — codex hook lane.** DONE (Memorable wave): SessionEnd capture landed —
  `src/core/bootstrap/codex-hooks.ts` (trust-gated two-file writer, verified spec
  target 2026-08-25) + `src/core/transcripts/codex-hook-lane.ts` + the capture-spec
  dispatch in hook.ts. SessionStart context on codex remains open (below).
- [ ] **P3 — codex SessionStart context lane.** The SessionEnd capture lane landed;
  a SessionStart greeting/context injection lane would close the loop (same
  trust-gated hooks.json mechanics, `CODEX_HOOK_EVENTS` gains 'SessionStart').
  **Start:** `src/core/bootstrap/codex-hooks.ts` (writer already generalizes),
  `src/commands/hook.ts` session-start branch. Filed from the Memorable wave
  (v0.46.30.0-era, 2026-08-25).
- [ ] **P1 — OpenClaw tool-call ARGS capture (Memorable value gate).** The openclaw
  lane ships name-only tool calls (`input: null` — the args field is unobserved in
  OpenClaw's session format), and Memorable's extraction API REFUSES name-only traces
  as `no_decisive_steps` (verified live with a synthetic ingest 2026-08-25): openclaw
  relays are currently rejected politely. One observation run against a real
  `~/.openclaw/agents/<agent>/sessions/*.jsonl` store must characterize the toolCall
  args field (+ any result block), then extend `mapOpenclawLine` — the interface
  (`ToolCallRecord`) is already final, so enrichment is additive. Until then the
  openclaw lane is plumbing-correct but value-dry. **Start:**
  `src/core/transcripts/openclaw.ts` (OPENCLAW_SPEC_TARGET note carries the checklist).
  Filed from the Memorable wave (2026-08-25).
- [ ] **P3 — native opencode capture lane.** opencode has no characterized session
  store, no transcript adapter, no discovery root — it rides `HookIo.harness` as a
  channel label only, and `captureSpecFor('opencode')` deliberately resolves to the
  claude spec (documented). A native lane needs an observation run against opencode
  1.18.18 (session store location + format), a new adapter, and a plugin/event-system
  integration (in-process JS, not a `gbrain hook` subprocess — raises the engine-free
  question). Until then: `memorable ingest -` is the documented path. **Start:**
  `docs/mcp/OPENCODE-CLI-PIN.md` + an observation run. Filed from the Memorable wave
  (2026-08-25).
- [ ] **P3 — hermes native capture lane.** SQLite one-store-many-sessions breaks the
  hand-the-hook-a-path contract, and `src/core/transcripts/hermes.ts` is still
  `provisional` (no populated production sample verified). `memorable ingest` is the
  documented path. Filed from the Memorable wave (2026-08-25).
- [ ] **P2 — verify memorable-cli ≥0.3.5 fixes the consent-before-egress ordering.**
  0.3.4's `record` POSTs the trace to `/v1/extract` BEFORE its consent-checked store
  (decompile-verified); gbrain mitigates with its own pre-spawn evidence check, but
  the complete fix is CLI-side (asked in the adoption PR, along with confirming the
  extraction API accepts arbitrary `harness` strings server-side). When a new CLI
  version ships, re-verify by decompile and consider relaxing nothing — the gbrain
  gate stays regardless. Filed from the Memorable wave (2026-08-25).
- [ ] **P2 — win32: resolveMemorableBin finds `.cmd` shims spawn() refuses to run.**
  The resolver accepts `.cmd`/`.exe` on win32 but the detached relay spawn passes no
  `shell: true` — Node/Bun refuse direct `.cmd` spawn since the CVE-2024-27980
  hardening, the async error is swallowed, and an npm-installed memorable on Windows
  looks resolvable yet never executes (only the delayed `relay_never_reported` doctor
  warn surfaces it). Fix: spawn via `cmd.exe /c` for `.cmd`/`.bat`, or resolve the
  underlying `.js` entry. **Start:** `src/core/context/hook-heartbeat.ts`
  resolveMemorableBin + the spawn site. Filed from the ship review (2026-08-26).
- [ ] **P3 — openclaw-only hosts never compact session-receipts.jsonl.** The openclaw
  lane deliberately skips receipts compaction (hook lane is the ONE compactor —
  two-writer rename race), so a host running ONLY the openclaw lane grows the file
  unbounded (slowly: name-only receipts are ~1-2 KB/line vs claude's ~110 KB). Fix
  shape: a converging-trim discipline like the relay file's, or a quiet-path
  compaction outside the compact() callback. **Start:**
  `src/core/context/hook-heartbeat.ts` appendSessionReceipt + context-engine.ts
  receipt block. Filed from the ship review (2026-08-26).
- [ ] **P3 — flag-registry generator: exclude spawn-argv string literals.** The
  text-scan generator picked up `--session` (from the memorable spawn argv) and
  `--harness` (from imports) into commands' accept-lists, so
  `gbrain sync --harness codex` is silently accepted instead of failing loud. Teach
  `scripts/generate-flag-registry.ts` to skip flags that only appear inside
  spawn()/argv arrays (or add an exclusion marker), then regenerate. **Start:**
  `scripts/generate-flag-registry.ts` + `src/core/cli-flag-registry.generated.ts`.
  Filed from the ship review (2026-08-26).
- [ ] **P3 — consolidate the memorable test fixtures.** The stub `memorable` shell
  script, the CLI-evidence config seed, and the full opt-in chain are re-implemented
  in four suites (memorable-relay.serial, context-engine-checkpoint.serial,
  doctor-memorable, session-receipts) — extract `test/helpers/memorable-fixtures.ts`
  so a consent-shape change is one edit. Filed from the ship review (2026-08-26).
- [ ] **P3 — readJsonlTailLines: incremental window growth.** The doubling retry
  re-opens and re-reads the whole window from scratch (up to ~31 MB cumulative in
  the pathological case) and zero-fills with Buffer.alloc; read only the
  newly-uncovered prefix on retry and use allocUnsafe. Rare path (fires only when a
  window holds zero complete lines). **Start:** `src/core/context/hook-heartbeat.ts`
  readJsonlTailLines. Filed from the ship review (2026-08-26).
- [ ] **P2 — openclaw real-plugin door: extend with a receipt+relay assertion.** The
  per-compaction Memorable receipt is pinned at the unit/serial tier
  (context-engine-checkpoint.serial MR1-MR3) but the installed-plugin e2e door
  (`test/e2e/openclaw-plugin-load-real.test.ts`) does not yet assert a receipt lands
  through the real plugin path; a deadline-seam unit test for the always-skip
  receipts-compaction posture is also unwritten. Filed from the ship review
  (2026-08-26).
- [ ] **P2 — codex e2e door: assert codex EXECUTES the trust-gated hook.** The heavy
  door asserts the hooks.json + trust-entry pair EXISTS but not that a live
  `codex exec` session-end actually fires it (a receipt landing after the smoke turn
  would pin gbrain's codexTrustHash against codex's fingerprint.rs for real — the
  golden-vector unit test pins OUR recipe, not the consumer's acceptance). **Start:**
  `test/e2e/bootstrap-real-codex.serial.test.ts` (heavy lane, keyless codex turn).
  Filed from the ship review (2026-08-26).
- [ ] **P3 — PGLite admin-lane scoped minting.** `gbrain bootstrap harness` refuses to
  mint under a live PGLite serve (single-writer) and points at pre-mint + `--token`.
  Auto-driving `POST /admin/login` + `POST /admin/api/api-keys` (when
  GBRAIN_ADMIN_BOOTSTRAP_TOKEN is present) would erase that friction — BLOCKED ON
  extending that admin route to carry a scopes/permissions payload (today it inserts
  only id/name/token_hash, so it can only mint full-access tokens, defeating the
  harness lane's least-privilege default). **Start:** `src/commands/serve-http.ts`
  api-keys route + `src/core/bootstrap/harness.ts` mint seam.
- [ ] **P3 — OpenClaw plugin setup hook (self-demoted from the #4043 wave).** The
  issue's closing ask is "frameworks call `gbrain bootstrap harness` at setup time".
  The in-repo `openclaw.plugin.json` cannot express it: OpenClaw installs plugins with
  lifecycle scripts disabled (`--ignore-scripts`) and the manifest schema has no
  setup/command field (verified against the OpenClaw plugin docs, 2026-08-12). When the
  plugin API grows a setup surface, add `gbrain bootstrap harness --yes` AND remove the
  manifest's static stdio `mcpServers.gbrain` entry in the same commit (one owner per
  server name). **Trigger:** OpenClaw plugin-API setup/command support shipping.
- [ ] **P3 — harness federated-drift visibility.** The harness token's
  `permissions.source_id` federation array is a mint-time snapshot of the
  `federated=true` sources; sources added later are invisible to wired sessions until
  a re-run rotates the token. `--status` could diff the snapshot against the live
  config and suggest a re-run — needs either an engine open (breaks status's
  engine-free posture under a live PGLite serve) or a sources probe over MCP with the
  recovered token. **Start:** `src/core/bootstrap/harness.ts:statusHarness`.
- [ ] **P3 — harness smoke: add BRAIN-IDENTITY comparison on top of the canary
  (ship-review residual).** The ship-review batch landed the two cheap layers: an
  apply-time CANARY (a random same-format bearer must fail auth before the real smoke —
  an impostor cannot tell the canary from the real token, so it is caught whichever way
  it answers) and immediate revocation of the fresh mint on any failed smoke. The
  remaining hardening is comparing the smoke's returned identity against the local
  brain's (the default mint path already opens the engine and could capture it);
  registrar mode (`--token` + remote url) has no engine and would state the weaker
  guarantee honestly. **Start:** `src/core/bootstrap/harness.ts` steps 5+8.
- [ ] **P3 — harness orphan-mint reconciliation (red-team finding).** A hard crash in
  the window between the mint INSERT committing and the `receipt.token.id` save leaves
  an ACTIVE token no receipt records — `--remove` cannot revoke it and doctor never
  flags it. On apply, when the prior receipt has `minted: true` but no id, list active
  `access_tokens` rows matching `token.name` created after `receipt.created_at` and
  fold them into `previous_ids` (or surface them loudly). **Start:**
  `src/core/bootstrap/harness.ts` step 5 + `src/core/token-mint.ts`.
- [ ] **P3 — bootstrap lock.ts error-path polish (plan micro-item, deferred at ship).**
  Non-EEXIST mkdir errors (EACCES/EROFS) misreport as BOOTSTRAP_IN_PROGRESS, and the
  missing-dir message says "workspace directory" even when the lock target is the
  gbrain HOME (harness lane) or a host config dir. Add an accurate message path.
  **Start:** `src/core/bootstrap/lock.ts:acquireBootstrapLock`.
- [ ] **P3 — dedupe `auth create` against `mintLegacyToken`.** `src/commands/auth.ts`
  create() re-implements the INSERT + `{a,b}` text[]-literal trick that token-mint.ts
  owns (the extraction note says so); routing create() through `mintLegacyToken` (the
  engine is in scope inside `withConfiguredSql`) would leave one canonical mint. Same
  for the doctor's inline `/health` probe vs `probeServeHealth`, which also wants an
  injectable fetch seam so `bootstrap_harness_health` tests stop making real TEST-NET
  calls (3s each). **Start:** `src/commands/auth.ts:create`, `src/commands/doctor.ts`
  bootstrap_harness_health.

## Agent-bootstrap wave follow-ups (filed at build time)

- [ ] **P2 — repoPhaseComplete is single-workspace (one global receipt).** The
  no-daemon push gate binds to the one `receipt.repo_url`, so with two bootstrap
  workspaces sharing a gbrain home, workspace B's `bootstrap repo` overwrites the
  receipt and permanently leaves A's per-turn/session-end pushes at
  `push_deferred_repo_pending`. Fails CLOSED (defers, never mis-pushes) and
  matches the v1 single-workspace contract, but the per-turn push made it more
  visible. Fix = per-root repo binding (a receipt map or a per-root marker).
  Surfaced by both v0.45.9.0 adversarial reviewers.
- [ ] **P2 — visibility ladder subprocess/body bounds.** `runWithTimeout`
  (`src/core/repo-visibility.ts`) races the `gh`/`git` probe against a timer but
  doesn't kill the raced child, and the anon-probe `res.text()` buffers the whole
  (operator-configured-origin) body before slicing. Bounded in practice by the
  detached push child's lifetime, but a proper fix kills the raced process and
  caps the body read. Filed from the v0.45.9.0 Codex adversarial pass.
- [ ] **P3 — `config set` for the file-plane hook-lane keys is engine-bound.**
  `runConfig` dispatches through the engine path, so `gbrain config set
  push.allow_unverified_remote true` can fail while a live PGLite serve holds the
  writer lock — the documented recovery command, unavailable exactly when needed.
  The env-var form (`GBRAIN_ALLOW_UNVERIFIED_REMOTE=1`) is the cloud path and needs
  no engine, so this is convenience-only; fix = route these two keys through the
  no-engine CLI dispatch. Filed from the v0.45.9.0 Codex adversarial pass.


- [ ] **P3 — plugin-based hook distribution for Claude Code.** Ship gbrain's
  hooks as a Claude Code plugin (`hooks/hooks.json` + `.claude-plugin/plugin.json`
  manifest, installed via the plugin marketplace flow) instead of two settings
  files. Plugins merge hooks first-class across scopes and update centrally —
  it would REPLACE both current carriers (repo-committed `.claude/settings.json`
  for cloud installs + gitignored `settings.local.json` for local), so it must
  migrate, not join; a third simultaneous carrier would double-fire events.
  Cons: needs marketplace repo hosting; enterprise `allowManagedHooksOnly`
  policies can block plugin hooks entirely. Start at
  `src/core/bootstrap/hooks.ts` (both writers + the dedupe rule live there).
  Filed from the cloud-DX eng review (v0.46.x wave).
- [ ] **P3 — watch Claude Code Channels as the push path for
  volunteer_context/signals.** Channels (research preview) push external events
  into a LIVE session — the native version of gbrain's push-context lane
  (`docs/guides/push-context.md`). Not actionable today: delivery requires an
  always-on session plus an Anthropic-allowlisted channel plugin. Revisit when
  channel-plugin distribution opens; the win is replacing per-turn pull with
  event push for signals/reflex windows. Filed from the cloud-DX eng review.

- [ ] **P1 — enforce op scope/localOnly on the stdio MCP dispatch when no auth
  context is present, and consider a narrower default surface for pull-mode
  harness registrations.** HTTP dispatch enforces `scope`/`localOnly` before
  handlers run; the stdio surface should reach parity so a registration that is
  user-global by host design (no per-project scoping available) does not expose
  more authority than the session needs. Surfaced by the v0.45.x ship
  adversarial pass (cross-model); pre-existing behavior, not introduced by the
  Codex scope-consent fix — that fix's prose now states the read+write reality
  honestly. Needs its own design pass (interaction with `--surface` pinning,
  MEMORY_VERBS, and the trust-boundary invariant in CLAUDE.md).
- [ ] **P2 — consent-key answers vs the A8 confirm gate.** Decide whether
  `consent: true` bank keys should be exempt from `setAnswer`'s confirmation
  invalidation (`src/core/bootstrap/interview.ts:308-309` `[A8]` deletes
  `state.confirmed` on ANY set) so operational consents can be recorded at their
  designed phase-contextual moment post-confirm without regressing
  `bootstrap status` to "answers complete but not confirmed" (status.ts
  interview detector). Deferred from the Codex MCP-scope fix (eng review option
  3B chose prose realignment instead: the runbook now records `MCP_SCOPE` in
  phase 3, pre-confirm, so the confirm hash covers it). An exemption touches a
  tamper-tripwire — a post-confirm flip of `PERSIST_CRON` (background-push
  consent) would no longer invalidate anything — so it needs its own
  adversarial review before landing. Also cover the healing half: pre-fix
  installs that recorded `MCP_SCOPE` at the old wire-phase moment have a
  permanently-invalidated confirm, and `bootstrap status` can't distinguish a
  consent-key invalidation from a tampered answer set — a status detail for
  that case would stop resumed installs being steered into a redundant
  re-confirm loop (ship-review data-migration finding). Context: eng review +
  codex consult of the Codex scope fix, 2026-08-11.
- [ ] **P2 — bootstrap first-push secret scan reads the working tree, not the
  index blobs; fail-open on binary/large files.** `secretScanOrThrow` /
  `scanFiles` (src/core/bootstrap/repo.ts + src/core/secret-scan.ts) read
  working-tree bytes and silently skip unreadable, binary, and >25 MiB files, so
  a git clean filter could commit a secret whose working-tree copy scans clean,
  and a secret in a binary/large file is never seen. Pre-existing across ALL
  bootstrap pushes (create + adopt), not specific to create-repo-first. Fix:
  scan the staged index blobs (`git show :file` / `git cat-file`) fail-closed,
  or reuse the hardened scanner path from `workspacePush`. Filed from the
  v0.45.2.0 /ship Codex adversarial pass (P0 there; scoped to P2 here as a
  shared-scanner hardening that needs its own tests, deliberately out of the
  create-repo-first change).
- [x] **P2 — compiled `gbrain` binary can now `serve` a PGLite brain.** FIXED:
  `src/core/pglite-embedded-assets.ts` embeds PGLite's runtime payload
  (`pglite.wasm`, `initdb.wasm`, `pglite.data`, `vector.tar.gz`,
  `pg_trgm.tar.gz`) with Bun's `import ... with { type: 'file' }` and hands them
  to PGLite via `PGliteOptions` (`pgliteWasmModule` / `initdbWasmModule` /
  `fsBundle` + custom `vector`/`pg_trgm` extensions whose `setup()` returns a
  `bundlePath` pointing at the embedded tarball, materialized to a temp file
  because `createReadStream` — unlike `readFileSync` — can't read `/$bunfs`
  paths). `src/core/pglite-engine.ts` spreads `getEmbeddedPgliteOptions()` at
  both `PGlite.create()` sites, so the Bun-vfs #1340 ENOENT no longer fires for
  a correctly-built binary. #4116 follow-up: the file-typed imports moved into
  the `pglite-embedded-asset-paths.ts` bundler anchor behind
  `resolvePgliteAssetPaths()`'s tiered lookup, because bun-global installs
  hoist pglite out of gbrain's node_modules on upgrade and the eager
  repo-relative imports crashed every command at module load; tier 2 derives
  the dist dir via module resolution (pinned by
  `test/pglite-hoisted-install.serial.test.ts`). Guarded by `scripts/check-pglite-embedded.sh`
  (compiles a smoketest and asserts a real PGLite query round-trips), wired into
  `bun run verify` + `check:all` + `check:pglite-embedded`. The real-agent e2e
  harness (`test/helpers/agent-harness.ts`) now resolves to the fast compiled
  MCP server; the `bun run` fallback stays as a safety net. Upstream Bun issue
  (still open since Nov 2024) is now moot for gbrain.
- [ ] **P1 — `--background --follow` spawns a nonexistent subcommand.**
  `src/core/cli-options.ts` (~:391) spawns `gbrain jobs follow <id>` after a
  background submit, but jobs.ts has no `follow` subcommand (`jobs watch
  --follow` exists and takes no id; `jobs submit --follow` is inline-only).
  The spawned child hits the unknown-subcommand path, so `--background
  --follow` submits fine but the live stream never attaches. Fix: implement
  `jobs follow <id>` (poll get_job + stream progress) or retarget the spawn.
  Found during the v0.45.0.0 doc audit; KEY_FILES documents current behavior.
- [ ] **P1 — bootstrap status is not workspace-scoped.** status.ts reads the
  newest GLOBAL verify snapshot + global push-status, so a green verify in
  workspace A can report workspace B as verified/healthy. Key the verify
  snapshots + push-status by workspace path (or store them under the
  workspace's own state dir) so status reflects the workspace it runs in.
  Found by the v0.45.0.0 adversarial pass (Codex P2, raised to P1 — multi-
  workspace is the graduation/multi-device story).
- [ ] **P2 — mkdir-lock ABA steal race (folds into the shared-primitive TODO).**
  Both acquirePushLock (workspace-push.ts) and acquireBootstrapLock (lock.ts)
  steal a dead+stale lock as rmSync-then-mkdir with no re-verify between, so
  two simultaneous stealers can both believe they hold it (same known class as
  pglite-lock; git index.lock bounds the push damage). When extracting the
  shared mkdir-lock primitive, harden the steal: re-read + token-compare the
  stale owner immediately before rmSync, or use an atomic rename-based steal.
  Cross-model finding (Claude + Codex) v0.45.0.0 adversarial.
- [ ] **P2 — uninstall TOCTOU on a live PGLite DB.** uninstall probes the serve
  lock then recursively deletes later; a serve starting in between wins the
  race. Gated today by the lock probe + refuse-on-live-serve, so this is the
  residual known lock-class window — close it when the shared lock primitive
  lands (hold the lock across the probe→delete span). Codex P1 v0.45.0.0.
- [ ] **P2 — sweep fairness: recency-only selection starves old pages.**
  sweep.ts pass 2 repeatedly takes the newest batchLimit pages with no
  extraction-watermark filter, so frequently-updated pages monopolize every
  sweep and older pages never get link/timeline extraction. Add an
  extracted-watermark (or round-robin) so the backlog drains. Codex P2.
- [ ] **P2 — untracked deny-glob exclusion is invisible under detached push.**
  A first-time deny-glob file (e.g. a fresh .env) is dropped from staging and
  reported only via the logger callback + excludedUntracked — but session-end/
  session-start auto-push runs via spawnDetachedPush with stdio:'ignore', so
  the warning is discarded. Fail-safe (never leaves the machine) but the user
  gets a false "synced" impression. Surface excluded deny-matches via the
  heartbeat/push-status file so doctor + status can report them. Claude
  adversarial (minor) v0.45.0.0.

- [ ] **P2 — shared receipt upsert helper.** InstallReceipt construct/merge
  logic is quadruplicated (bootstrap.ts writeRenderReceipt +
  appendReceiptRegistration, attach.ts, repo.ts recordRepoInReceipt) with
  slightly different defaults; guardReceiptOverwrite is wired at each site
  individually. One `upsertReceipt(home, ws, patch)` in format.ts.
- [ ] **P2 — promote the atomic tmp+rename write idiom to one core helper.**
  ~7 hand-rolled copies across format.ts/interview.ts/lock.ts/render.ts/
  hook.ts/workspace-push.ts/verify.ts; hooks.ts already has a private
  atomicWriteJson to promote (plus a text variant).
- [ ] **P2 — extract a shared mkdir-lock primitive.** bootstrap/lock.ts and
  workspace-push.ts both implement atomic-mkdir + PID/age/token steal rules
  citing the same pglite-lock learnings (#2058/#2348); three parallel
  implementations counting pglite-lock. One primitive with injectable stale
  window + throw-vs-result adapters.
- [ ] **P2 — move the hook heartbeat read surface into core.** core/bootstrap/
  status.ts and core/bootstrap/verify.ts dynamic-import readHeartbeatTail
  from commands/hook.ts (core→commands inversion). A core/hooks-telemetry.ts
  owning the read/write surface removes the reach-ins.
- [ ] **P2 — consolidate the two GitHub remote parsers + privacy probes.**
  workspace-push.ts parseGithubOwnerRepo (accepts ssh:// + trailing /) vs
  repo.ts parseGithubRemote (scp-form only), and verifyRemotePrivacy (gh repo
  view) vs verifyRepoPrivate (gh api): grammars/failure classes can drift.
  One exported parser + one privacy-probe core returning the verdict union.
- [ ] **P2 — connector-ingest capability probe (with v1.1 connector ingest).**
  The plan's build-order-2 probe (email/calendar connector availability wired
  into install output) deferred with the feature it gates; the capability
  report today covers embeddings + extraction only.
- [ ] **P2 — G15 retention warnings in doctor.** MEMORY.md size cap + corpus
  retention + orphaned stop-hook buffers are enforced/pruned but doctor never
  warns when they accumulate; add the three checks to the bootstrap group.
- [ ] **P2 — NER-based graph floor in verify.** The graph-floor check asserts
  wikilink-edge/backlink link-table rows; a true entity-extraction floor
  (≥1 NER entity + one edge-only query op) needs the extraction path or a
  keyed provider, so it rides with a keyed-mode verify extension.
- [ ] **P2 — `--isolated` flag productization.** GBRAIN_HOME threading through
  MCP registration env, hooks, and uninstall guards ships in v1; the
  documented `bootstrap --isolated` one-flag wrapper (set env + assert
  database_path containment + gitignore check, per D2=C) is not yet a flag.
- [ ] **P2 — sweep N+1 page fetch.** The links/timeline pass getPage-per-slug
  loop is bounded (batchLimit 20) but serializes round-trips on the live
  serve connection; add a getPagesBySlugs batch read to both engines (engine
  parity + bootstrap-probe obligations) and use it.

- [ ] **P2 — `gbrain quota` meter command.** Productize the release-gate quota
  measurement (script+doc ship with the bootstrap wave) into a command that reports
  a session/day's token burn against the harness subscription allowance. Blocked on
  a proven per-harness token-count method — an inaccurate meter erodes the trust it
  exists to build (CEO review D3.4; not promoted by a passing quota gate, by
  decision). Start: the spike's measurement scripts under docs/designs/.
- [ ] **P2 — Networked Docker paste-flow e2e.** The offline container e2e (interview
  → render → verify with fake gh) ships with the wave; the full networked flow (bun
  install, gh auth, repo create, MCP registration) stays manual. Unblocks after 10
  consecutive green offline runs in heavy-tests (CEO review D3.3b). Start:
  tests/docker/ harness + the fake-gh recording shim.
- [ ] **P2 — Real-agent door e2e needs a provisioned runner.** The real-binary door
  tests (`test/e2e/bootstrap-real-{claude,codex}.serial.test.ts`) drive the ACTUAL
  `claude`/`codex` binaries against a real gbrain and pay API cost. They self-SKIP
  (`describe.skipIf` on binary/auth) everywhere else, so the `real-agent-e2e` job in
  `.github/workflows/heavy-tests.yml` is a green no-op on stock GitHub runners. To
  actually EXERCISE them we need a self-hosted / manually-provisioned runner with
  authed `claude` + `codex` and provider creds exported
  (`GSTACK_ANTHROPIC_API_KEY`/`ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`). Until then they
  run locally on an operator machine only. Start: stand up a labeled runner with the
  binaries pre-authed, or a scheduled self-hosted lane.

- [ ] **P1 — unit-shard exit hang: bun test process leaks a ref'd handle and never
  exits after all tests pass.** Probabilistic (scales with file count/duration),
  PRE-EXISTING: reproduces on origin/master with the same 274-file combination
  (`bun test $(cat list) --max-concurrency=2` — shard-2 composition from the
  agent-bootstrap wave's reshuffled split; solo halves/eighths pass, full list
  hangs on both branches; a repeat of the same 68-file quarter passed, so it is a
  race, not a single file). Forensics: the "[process-cleanup] db-lock:test:r1:
  PGlite is closed" tail line is printed BY the SIGTERM cleanup at kill time, not
  pre-hang; db-lock refresh + process-watchdog intervals are already unref'd —
  the leak is elsewhere (candidate class: a ref'd handle in a PGLite/worker
  teardown race). run-unit-parallel.sh now classifies the exact signature
  (killed at cap + all assigned files started + zero fail markers) as a loud
  warn-pass so it can't red-X unrelated work; fixing the leak removes the
  classifier's reason to exist. Start: reproduce with `--inspect` /
  Bun.unsafe process handle dumps on the full shard-2 list.
- [ ] **P2 — WAL-repair unit tests flake under parallel shard load.**
  `test/pglite-repair.test.ts` (`repairPgliteWal rename-based backup`,
  `inspectPgliteDataDir verdicts`) failed once in a full 4-shard run and pass
  44/44 standalone — load-sensitive, from the v0.42.75.0 WAL auto-repair wave
  (pre-existing on master; observed during the agent-bootstrap gate runs).
  Start: run the file under `--max-concurrency=4` alongside PGLite-heavy
  neighbors to reproduce; suspect tmp-dir or timing assumptions.

## Giftable-import wave follow-ups (filed at build time)

- [ ] **P1 — Wire citation edge types into relational retrieval.** `relational-intent.ts`
  recognizes a hardcoded edge-type set that excludes `overrules`/`distinguishes`/
  `relies-on` (the types citation-graph-ingest creates). Until they're walked by
  natural-language relational recall, the skill's value is explicit `graph-query`
  only. Add the types + an eval fixture proving a relational question traverses a
  citation edge. Files: `src/core/search/relational-intent.ts`,
  `src/core/search/relational-recall.ts`.
- [ ] **P2 — Native operation-boundary confirm for destructive ops.** data-loss-gate
  is routing prose; destructive paths (bulk forget, `delete_page` sweeps, source
  removal, mounts remove) can bypass it via CLI/MCP/jobs. Add a native confirm
  (TTY prompt / `--yes` flag / MCP scope) at the operation boundary.
- [ ] **P2 — `gbrain ingest feed`: native feed adapter.** blog-ingest ships the
  agent-procedure layer; the durable path is a deterministic RSS/Atom adapter
  (discovery, pagination, canonical-URL dedup, 429 backoff) behind one command.
- [x] **P2 — Native AI-chat export importer.** **Completed:** v0.46.0.0 (2026-08-14).
  `gbrain transcripts ingest` imports extracted ChatGPT and Claude.ai
  `conversations.json` exports natively (adapters at
  `src/core/transcripts/{chatgpt-export,claude-export}.ts`, rendering on the
  conversation-parser surface). Perplexity has no adapter yet — a candidate
  leaf module on the same `TranscriptAdapter` seam (the pattern the
  cathedral-4 "More harness adapters" follow-up below documents); the
  conversation-archive skill keeps the manual procedure for it meanwhile.
- [ ] **P2 — Perplexity live connector.** The chat-connectors feature ships
  ChatGPT + Claude live sync (`src/core/connectors/`). Perplexity is deferred:
  it needs BOTH a cookie-REST provider (`providers/perplexity.ts`) AND a native
  `perplexity` transcript adapter (`src/core/transcripts/perplexity-export.ts`)
  since none exists — a registry stub with no adapter would route to a lane
  that can't parse it. Until then, Perplexity uses the conversation-archive
  manual conversion. Where: `src/core/connectors/providers/`, `registry.ts`,
  `src/core/transcripts/`.
- [ ] **P3 — Connector advisor collector.** Surface connector credential/sync
  health in `gbrain advisor` (a collector in `src/core/advisor/`), mirroring the
  `gbrain doctor` `connectors` check. Doctor covers v1; advisor is the ranked-
  actions v2 surface.
- [ ] **P3 — Multi-account per connector provider.** `ConnectorCredential`
  already carries `accountId`; wire per-account credential files + routing so a
  user can sync two ChatGPT accounts into different sources. Where:
  `src/core/connectors/credentials.ts`, `sync.ts`.
- [ ] **P3 — Connector attachment/image capture.** v1 is text-only. Fetch and
  ingest conversation attachments/images (route through the existing image
  import path). Where: `src/core/connectors/providers/*`, `import-file.ts`.
- [ ] **P3 — Export-ZIP auto-unwrap.** Accept a raw ChatGPT/Claude export `.zip`
  directly in `gbrain transcripts ingest` (currently "unzip first"). Adjacent to
  connectors; benefits the export-file lane. Where: `src/core/transcripts/export-json.ts`.
- [ ] **P3 — Nightly connector spec-target drift probe.** A
  `conversation-parser/nightly-probe.ts`-style live probe of each connector
  provider's API shape (list/detail), alarming when the provisional
  `HostSpecTarget` drifts. Where: `src/core/connectors/providers/*`, a new probe.
- [ ] **P3 — History-scoped OAuth revisit.** ChatGPT OAuth PKCE currently yields
  codex-scoped tokens, so the connector ships it demoted behind `--try-oauth`
  with cookie as the primary lane. Revisit if OpenAI ships a conversation-
  history OAuth scope. Where: `src/core/connectors/providers/chatgpt.ts`.
- [ ] **P2 — Entity-guard as a native op.** phonetic-name-guard's own changelog
  proves prose-only failed: ASR-variant entity collisions need a native check
  (registry + alias table consulted at put/import time). The wave shipped the
  registry-first discipline in brain-ingest-gate; this hardens it.
- [ ] **P2 — Premiere-repo program ① distribution:** list gbrain on skills.sh +
  Claude Code plugin marketplace + agentskills.io conformance; README cross-
  harness matrix (CI-verified). First fast-follow PR after this wave.
- [ ] **P2 — Premiere-repo program ② receipts:** public BrainBench receipts page
  pairing accuracy with token cost per query, regenerated per release; "trust
  layer" framing (data-loss-gate + brain-ingest-gate + correction-pipeline).
- [ ] **P3 — Premiere-repo program ③ protocol moat:** Anthropic memory-tool
  (`memory_20250818`) adapter backed by recall/remember; publish MEMORY_VERBS_v1
  as an open spec with BrainBench as its conformance suite. Own cathedral.
- [ ] **P3 — Premiere-repo program ④ badges:** per-skill conformance badges
  (security-scan + eval-receipt + provenance hash) surfaced in manifest/README;
  generalize the functional-area-resolver A/B harness into `evals/skills/`.
- [ ] **P3 — RESOLVER two-layer compression as its own PR.** Deferred out of the
  wave at eng review: requires arrow-form dispatcher entries, the A/B run at
  >=95% (per the functional-area-resolver contract), resolver.test.ts updates,
  and fixture backfill for fixture-less skills. RESOLVER.md is now past the 12KB
  gate, so the skill's precondition is satisfied.
- [ ] **P3 — extract-atoms quality-gate prompt patch.** Fold the donor pack's
  truism filter / statistic-punchline test / entity-page routing test / named-
  attribution rule into `src/core/cycle/extract-atoms.ts`'s EXTRACT_PROMPT,
  eval-gated (the native prompt's only bar today is "not a generic platitude").
- [ ] **P3 — cross-modal eval `--corpus` hub-and-spoke mode + judge-leniency
  normalization.** Follow relative .md links from a hub page so multi-page brain
  artifacts aren't falsely penalized; normalize per-judge leniency in
  `src/core/cross-modal-eval/aggregate.ts` (mean+floor only today).
- [ ] **P3 — Advisor collectors: freshness-monitor + context-audit token drift.**
  Two new collectors: per-source staleness SLA (the donor freshness-monitor
  kernel) and a deterministic loaded-context token-drift check feeding the
  context-audit skill.
- [ ] **P3 — idea-miner import (deferred at CEO review, fit 6).** Daily brain-
  grounded "what could I build" mining feeding skill-creator; below the wave's
  fit bar but a strong self-improvement story.
- [ ] **P3 — public-repo-guard revisit.** Only egress leak-gate candidate; its
  upstream scan script fails open (`SCAN_EXIT` captured after `|| true`). Fix
  upstream first; template-ize the patterns file; mind the gstack cso boundary.
- [ ] **P3 — `search --fm` + schema-pack fragment** from the social-json-store
  audit disposition: frontmatter-ID/JSONB query kernel as a native search flag
  + a schema-pack fragment, not a skill.
- [ ] **P3 — back-catalog-check kernel.** Optional pre-publish own-corpus
  consistency pass folding into fact-check (per-claim own-record search);
  `find_contradictions` + idea-lineage cover the rest today.

## Skill self-knowledge — semantic skill search (deferred subsystem, from the migration-harness build)

- [ ] **P2 — Make built-in skills semantically searchable in the brain.** Today skills
  are markdown the harness routes to via triggers + a host catalog (`list_skills`/
  `get_skill`); `gbrain search "how do I verify claims"` can't surface `fact-check`.
  Making skills first-class searchable content needs a real design pass (tenancy +
  source-isolation: skill pages must not pollute user-source query results; embedding
  storage + backfill; search-steering to include/exclude the skill catalog; engine
  parity). Deliberately NOT built in the currency/preconditions wave — it is a
  subsystem that deserves its own eng + CEO review, not a rider. The currency work
  (`skillpack status`/`sync`, doctor `skill_currency`) already keeps the brain's skill
  set current on upgrade; this item is purely about semantic retrieval of skills.

## opencode wave follow-ups (filed at build time)

- [ ] **P2 — Watch the first opencode-door + canary dispatches.** The job is
  day-one full posture (nightly + labels; keyless SMOKE + paid anthropic leg
  on the existing secret) — after the wave merges, confirm the first nightly
  run goes green end-to-end and the canary leg's latest-version result, then
  update OPENCODE-CLI-PIN.md §Pending auth with anything the authed CI run
  observes (exact `opencode models` output, per-turn cost note). Effort: S.
- [ ] **P3 — Wire opencode's plugin/event system** (the ambient-recall lane).
  opencode ships a JS plugin system with lifecycle events; `OPENCODE_HAS_HOOKS
  = false` in host-specs.ts marks the gap. Needs its own observation pass
  (plugin API shapes, event timing, context-injection surface) before design —
  would upgrade opencode from pull-protocol to per-turn push, above codex.
  Effort: M/L.
- [ ] **P3 — BrainBench opencode adapter.** `src/eval/brainbench/adapters/` +
  `ALL_HARNESSES` entry — build together with the already-filed hermes + grok
  adapters (three pending; one eval wave). Effort: M.
- [ ] **P3 — connect `--agent opencode --oauth`.** opencode's `mcp auth` is an
  authorization-code OAuth flow (not client-credentials) — a connect lane for
  it needs the interactive-grant plumbing the current `--oauth`
  (perplexity/generic client-credentials) path does not model. Effort: M.
- [ ] **P3 — Re-observe the OPENCODE_CONFIG* env trio on version bumps.**
  Observed INERT in 1.18.18 (docs-contradiction pinned in OPENCODE-CLI-PIN.md
  §Path seams); host-specs resolves via XDG only. If a future release
  activates them, `opencodeConfigDir()` and the hermetic child-env deletes
  must move together. The pin doc's re-observation checklist carries the
  probe. Effort: S.
- [ ] **P3 — opencode-install PTY promotion.** Same criterion as grok-install:
  2 consecutive stable dx-scenario runs ≥1 month apart with unchanged
  boot/first-run copy → promote to a PTY assertion test. opencode's keyless
  free tier means the scenario should COMPLETE the bootstrap, making it a
  stronger promotion candidate than grok's sign-in-wall early-stop. Effort: M.

## Transcripts-import follow-ups (filed from cathedral-4, `gbrain transcripts ingest`)

Scoped OUT of the cathedral-4 PR by the CEO review's cherry-pick ceremony and the
eng review — each carries a named design, none is a bug. Context: the import lane
(adapters at `src/core/transcripts/`, session-atomic pipeline, embed-OFF default)
covers DEAD logs; go-forward capture beyond Claude Code is deliberately absent.

- [ ] **OpenClaw go-forward capture.** Blocked upstream: the OpenClaw PluginApi exposes only `registerContextEngine` — no end-of-turn/agent-end capability. When the host grows one, the plugin (`src/openclaw-context-engine.ts`) subscribes and emits the session into the corpus lane (`~/.gbrain/transcripts/corpus` sidecar protocol) the way `gbrain hook session-end` does for Claude Code; the openclaw session PARSER already ships. Consent must ride a capture line like the bootstrap harness `--no-capture` model. Priority: P2.
- [ ] **Codex go-forward capture (notify sweeper).** `docs/designs/AGENT_BOOTSTRAP_PLAN.md` FF2 names the design (notify sweeper over `~/.codex/sessions`); the rollout parser now ships in `src/core/transcripts/codex.ts`, so the sweeper is pure wiring: on codex notify, run `gbrain transcripts ingest <rollout> --quiet`. Needs the same consent posture as capture. Priority: P2.
- [ ] **Scheduled re-import cycle phase.** `transcripts ingest --since last --all` as an opt-in cycle phase so dead-log import self-refreshes. REQUIRES its own consent-line design first: reading harness dirs on a schedule is capture-adjacent (the "Autonomous transcript watchers" decision above rules the spirit); the clean-scan watermark + status gap table already make manual re-runs cheap. Priority: P3.
- [ ] **PII auto-detection redaction pass for imports.** The native lane redacts secrets (secret-scan) + user patterns (`harvest-private-patterns.txt`, emails included) and counts imperatives; broad PII detection (names, phones, addresses) is its own subsystem — the conversation-archive skill keeps the human scrub step for sensitive corpora meanwhile. Priority: P2.
- [ ] **More harness adapters: Cursor / Gemini CLI / Copilot CLI.** Leaf modules on the `TranscriptAdapter` seam (~1h each with an agent): dated SPEC_TARGET + scrubbed fixture + drift alarm, per the shipped six. Formats unverified locally — verify a real sample first (the hermes gate pattern). Priority: P3.
- [ ] **ChatGPT/Claude.ai export zip unwrapping.** v1 requires the EXTRACTED `conversations.json` ("unzip first" is documented + error-hinted). Add zip handling without a heavy dependency (Bun has no built-in zip; evaluate a minimal vendored inflate or shelling to `unzip` with confinement). Priority: P3.
- [ ] **BrainBench raw-format fixture schema (sibling repo).** The in-repo pin (`test/e2e/transcripts-writeback-fidelity.test.ts`) grades raw files through the adapters with the gold extractor, but the BrainBench corpus schema (gbrain-evals) still rejects unknown keys and its corpus hash doesn't cover raw sidecars. Needs: versioned raw-fixture sidecar type + loader + hash coverage + baseline re-cut in gbrain-evals, then a `write_back_fidelity_raw` suite row here. Priority: P2.
- [ ] **Hermes SPEC_TARGET verification against a populated store.** The schema came from the installed hermes-agent v0.20.0 source (`SCHEMA_SQL`), but no populated `state.db` existed on the dev machine — the fixture is synthetic-by-declaration. Verify against a real store after some Hermes sessions accrue, then flip `status: 'provisional'` → `'verified'` and pin the `active`/`compacted` semantics the adapter currently ignores. Priority: P3.
## Grok Build wave follow-ups (filed at build time)

- [ ] **P1 — Enable the grok-door paid lane once XAI_API_KEY exists.** Admin
  creates the `XAI_API_KEY` repo/environment secret (console.x.ai; prefer a
  protected GitHub Environment scoped to door jobs), then one commit re-adds
  to `grok-door` in heavy-tests.yml: the `schedule` leg, the `heavy-tests`
  label leg, default-on dispatch, and a latest-version CANARY matrix leg
  (`continue-on-error`, schedule-scoped, own timeout) so the pinned lane stays
  deterministic while the canary tracks what users run. Same session: run the
  pending-auth Phase-0 observations (paid one-shot smoke, authed model list +
  measured per-turn cost pins, credential-file inventory after login → door
  evidence exclusions + TTY secretPaths, authed first-run TUI copy) into
  `docs/mcp/GROK-CLI-PIN.md`, and pin `parseGrokJson` + the separate
  non-retried JSON toolCall door test (one extra paid turn) once the
  streaming-json event shape is observed. Effort: S (CC ~30min + admin).
- [ ] **P2 — `gbrain connect --agent grok`.** One-command install UX:
  `AgentId`/`AGENT_SPECS`/`AGENT_IDS` in `src/commands/connect.ts`, a
  `buildGrokMcpAddArgv` in `src/core/mcp-registration.ts` (shape already
  pinned in GROK-CLI-PIN.md), connect tests ("all four agents" pin moves to
  five), KEY_FILES entry. Deferred from the grok wave to avoid a second
  observation pass; the pin doc now exists, so this is mechanical. Effort: S.
- [ ] **P2 — HERMES.md surface refresh.** The hermes register command predates
  the truthful-surface wave and wires the full 100+-op catalog;
  CLAUDE_CODE.md + GROK.md now recommend `--surface verbs`. Update the
  register one-liner + Direct config block (+ INSTALL_FOR_AGENTS hermes
  block) and re-verify against the pinned hermes. Effort: S.
- [x] **P2 — Backport the GITHUB_ENV/GITHUB_PATH/GITHUB_OUTPUT/GITHUB_STATE
  deletion from `grokChildEnv` to `hermesChildEnv`** (and consider narrowing
  the `GITHUB_` ALLOW_PREFIX to the read-only metadata names) — the prefix
  rule forwards writable CI step-metadata files to untrusted agent children.
  Unit truth-table exists for the grok side to clone. Effort: S.
  DONE (opencode-support wave): `hermesChildEnv` now rides `makeAgentChildEnv`,
  which scrubs the GITHUB_* step-metadata files for every door agent; truth-table
  extended in `test/helpers/agent-harness.unit.test.ts`.
- [ ] **P3 — Grok bootstrap-harness target.** `gbrain bootstrap` personal-agent
  support for Grok Build: `HarnessSelector` + `parseHarnessArgs`, a dated
  `TARGETS` spec in `host-specs.ts`, a `wireGrok` branch + TOML writer (grok
  config schema pinned; `codex-toml.ts` is the precedent), receipt/rollback/
  status handling, and the INSTALL_FOR_AGENTS honest-classification flip.
  Docs currently state "bootstrap does not support Grok yet". Effort: M.
- [x] **P3 — Door-adapter extraction (test-side) + door cadence policy.**
  Trigger FIRED at the 4th door agent (opencode, the opencode-support wave):
  `makeBinaryResolver`/`makeAgentChildEnv`/`runOneShotSpawn` extracted in
  `test/helpers/agent-harness.ts`, grok+hermes ported (hermes gained the
  GITHUB_* scrub + bounded drain), opencode landed as first consumer; the
  cadence policy is adopted in `docs/TESTING.md` (nightly for the newest
  agent, label-only after 2 stable monthly cycles).
- [ ] **P3 — Door CI-tail composite action.** Trigger: the FIRST GREEN
  grok-door AND opencode-door dispatches (workflow yaml cannot be proven
  locally, and refactoring never-run jobs compounds risk — grok-door has
  never dispatched: its XAI_API_KEY secret does not exist yet). Hoist the
  shared workflow tail (evidence prep / scrub triple / upload / pass-count +
  paid sentinels / version re-check / cred cleanup) from
  hermes-door/grok-door/opencode-door into a composite action; port
  opencode-door as first consumer (it is the freshest copy). Until then the
  three doors' scrub blocks carry cross-reference comments. Effort: M.
- [ ] **P3 — Promote grok-install to a PTY assertion test.** Criterion: 2
  consecutive stable runs ≥1 month apart of the dx scenario (pre-ship ritual
  on grok-touching waves) with unchanged boot/sign-in copy. Would be the
  repo's first gbrain-driving PTY assertion test — keep it an instrument
  until the copy proves stable. Effort: M.
- [ ] **P3 — Nightly cross-agent friction-diff artifact.** After door runs,
  `gbrain friction diff --base <hermes-run> --compare <grok-run>` rendered
  into a CI artifact so guide-following friction regressions surface without
  a dev-box session. Effort: S/M.
- [ ] **P3 — `xai:` provider block in model-pricing.ts.** Grok models
  (grok-4.6/4.5 observed) for cost views once xAI pricing is sourced;
  separate concern from the harness wave (CANONICAL_PRICING discipline).
  Effort: S.
- [ ] **P3 — BrainBench grok adapter.** `src/eval/brainbench/adapters/` +
  `ALL_HARNESSES` entry — same seam as the already-filed hermes adapter
  (TODOS "BrainBench hermes adapter"); build both together. Effort: M.
- [ ] **P3 — Client-registry unification (Approach C).** The repo carries 7
  hardcoded client lists (connect AGENT_SPECS, bootstrap Harness,
  HarnessSelector, host-specs TARGETS, claw-test registry, brainbench
  ALL_HARNESSES, volunteer HARNESS_CHANNELS); grok proved the claw-test
  registry shape generalizes. Unify into one data-driven table AFTER the
  door-adapter extraction lands (earn it — don't freeze hermes-isms in).
  Effort: L.
- [x] **P3 — PIN-doc privacy guard.** DONE (opencode-support wave):
  `scripts/check-pin-doc-privacy.sh` (in `bun run verify` + guards-manifest,
  fixture-tested) asserts every `docs/mcp/*-CLI-PIN.md` uses placeholder paths
  and carries no key-shaped material or non-example emails.
- [x] **P3 — opencode-door npm view-vs-install TOCTOU.** DONE (adversarial-review
  fix wave): the door job's install step is now pack-verify-install — `npm pack
  <pkg>@<ver> --json` downloads the artifact and reports the integrity of the
  BYTES written; both the wrapper and the platform payload are asserted against
  their pins before `npm install -g ./opencode-ai-*.tgz` installs from the
  verified local tarball (no fresh registry resolve of the name; the payload's
  install-time fetch is npm-validated against the same byte-confirmed packument).
  Verified locally on darwin-arm64 (wrapper integrity == pin; `--ignore-scripts`
  breaks opencode's postinstall binary placement, so it is deliberately absent).
- [x] **P3 — `opencode mcp list` probe spawns project-config servers.** DONE
  (adversarial-review fix wave): the user-scope probe spawns from a fresh EMPTY
  mkdtemp cwd (no project config can load), project scope SKIPS the live probe
  entirely with a printed note (parse-back is authoritative), and the probe now
  holds the real process handle so the 20s timeout actually kills the child
  (SIGTERM → SIGKILL) instead of abandoning it.
- [ ] **P3 — dedupe the opencode read→parse→classify dance.** The
  read-config → parseOpencodeConfig → opencodeEntryKind sequence is spelled
  three times (bootstrap.ts runHooks pre-check, harness.ts apply expectUrl
  fallback, harness.ts remove ownership check); extract a
  `classifyOpencodeEntryAt(path, name, expect)` helper and drop the
  double-printed other-source warning (the caller AND the writer note it).
  Effort: S.

## opencode adversarial-review fix-wave follow-ups (filed at fix time)

- [ ] **P2 — per-harness MCP-scope consent key.** An interview MCP_SCOPE answer
  recorded for Claude Code (where 'project' is the privacy-SAFE default)
  currently authorizes opencode's INVERTED-risk scopes without fresh
  confirmation ('project' on opencode = committed file that auto-spawns on
  every collaborator machine, no trust gate), and an ABSENT answer defaults
  opencode to user-global exposure (any repo on the machine reaches the
  brain). Design a harness-specific consent confirm — either per-harness
  answer keys (MCP_SCOPE_OPENCODE) or a one-time "your recorded scope means
  something riskier here — confirm" gate on the opencode lane. Relates to the
  agent-bootstrap A8 consent-semantics TODO. Effort: M.
- [ ] **P3 — opencodeEntryKind remote ownership: normalize the url compare.**
  Ownership uses exact string equality on the entry url vs the receipt/expect
  url — trailing-slash and host-case variants misclassify in BOTH directions
  (ours read as foreign → orphaned entry; a variant-url foreign endpoint
  never matches, fine, but the asymmetry is accidental). Consider URL
  normalization (scheme/host case-fold, trailing-slash) plus an
  Authorization-shape check before comparing. Effort: S.
- [ ] **P2 — claw-test --live runners inherit real HOME/XDG.** The grok /
  hermes / opencode --live runners run against the operator's real
  HOME/XDG config surface and only WARN on a pre-existing global gbrain
  entry; a scripted run can mutate or exercise the operator's live wiring.
  Consider a fail-closed flag (refuse when a global gbrain registration
  exists unless --allow-live-config) or hermetic-by-default across the
  runner family. Effort: M.
- [ ] **P3 — fixed-name `.bak` parity: codex-toml.ts + hooks.ts writers.**
  opencode-json.ts now takes UNIQUE `.bak-<hex>` backups per operation
  (overlapping runs can't clobber each other's snapshot; harness restores
  from the returned path and unlinks on success). The codex TOML writer and
  the hooks settings writers still use fixed-name backups with the same
  theoretical overlap window — port the unique-backup pattern (and the
  restore-guard compare) for parity. Effort: S/M.
## Dream triage cascade follow-ups (#4152, filed at implementation)

- [ ] **P2 — Incremental submit-drain + deadline threading in synthesize
  fan-out.** What: restructure the fan-out to submit bounded batches and
  drain each before submitting more, stopping against the parent job's
  `deadlineAtMs`. Why: today the phase bulk-submits every accepted child
  then drains sequentially inside `autopilot-cycle`'s 30-min wall clock
  (`handler-timeouts.ts:44`); a timeout mid-drain strands the remainder in
  the run's private queue (the C1 self-heal + retriage conversion now
  recover them, but not creating strands beats recovering them). Blocked
  by: `runCycle` does not thread deadline/abort into phases (verified
  absent at the synthesize call site, cycle.ts ~2030). Context: outside
  voice C2 on the #4152 eng review; the triage `max_ms` budget bounds the
  cheap half, this bounds the expensive half. Effort: M/L.
- [ ] **P2 — Scheduled reject sample-audit with spend-posture
  integration.** What: automate `dream retriage --audit-rejects N` on a
  cadence (weekly cron or post-cycle sampling) writing disagreement-rate
  telemetry, gated by `spend.posture`. Why: the threshold is an
  intuition-set 0.5 until real false-negative data exists; the cascade
  literature is unanimous that unaudited gates drift (eng-review search
  check). The manual flag ships with #4152; this files the loop that runs
  without an operator remembering. Depends on: a few weeks of production
  score distributions. Effort: M.
- [ ] **P3 — Borderline-band routing (0.30–0.49 → mid-tier model or batch
  digest).** What: a second lane where near-threshold files get a cheaper
  treatment instead of the binary keep/drop. Why: the issue marked it
  optional; it adds a third model lane + a second threshold pair, which
  should be tuned from `details.triage` score distributions rather than
  guessed. Blocked by: production calibration data (see the audit TODO
  above). Effort: M.
- [ ] **P3 — Source×corpus multiplier: per-source corpus mapping or
  explicit fan-out consent.** What: `dream.synthesize.session_corpus_dir`
  is GLOBAL config while synth idempotency keys are SOURCE-namespaced, so
  N registered sources each re-fan the same corpus (a live deployment saw
  3 × ~1,250 jobs/day of the same files). Triage verdicts are
  source-agnostic (judged once) and the cascade cuts each source's fanout
  by the pass rate, but total synthesis is still N× the corpus. Why
  deferred: pages land per-source, so per-source synthesis may be intended
  semantics for some operators — needs its own issue + design (per-source
  corpus config keys vs an explicit multi-source consent flag). Diagnostic:
  `dream retriage --reconcile-queue --json` reports `queue.by_source`.
  Context: outside voice C3 argued root-cause-first; scoped out twice
  during the #4152 review. Comment on #4152 after ship. Effort: M.
- [ ] **P3 — Dream triage perf follow-ups (from the #4152 ship review).**
  What: (a) batch the per-file `getDreamVerdict` PK probes in `runTriagePass`
  into one prefetch (unnest join on (file_path, content_hash)) and reuse it
  for retriage's spend-estimate loop (currently 2×N sequential roundtrips on
  the operator sweep); (b) a partial index for `countRecentSynthSubmissions`
  (`(created_at) WHERE name='subagent' AND idempotency_key LIKE
  'dream:synth-v2:%'`) so the opt-in daily cap's count is index-served on
  busy brains; (c) a shared `seedTriageVerdict` test helper to collapse the
  five hand-rolled triage-v1 seed blocks. Why: all flagged by the ship
  review's performance/maintainability specialists; none block — cache
  probes are ~0.1% of adjacent LLM latency and the cap is default-off.
  Effort: M.
- [ ] **P3 — Per-file single-flight for triage cache misses.** What:
  concurrent passes (retriage while a cycle runs) can double-judge the same
  uncached file (~1¢/file, last-write-wins converges — benign but untidy);
  a per-(file,hash) advisory claim would dedupe. Why deferred: real locks
  are heavy machinery for a benign-cost race; the retriage help documents
  the behavior. Context: outside-voice CX5 on the #4152 ship review.
  Effort: M.

## Local-lane green wave follow-ups (filed at build time)

- [ ] **P2 — Gate `installSigchldHandler()` on `import.meta.main` too.** Same
  class as the process-cleanup SIGTERM leak fixed in this wave (cli.ts:3-4):
  a process-wide SIGCHLD reaper installs into any process that merely imports
  cli.ts — in a bun test runner it could race Bun's own child reaping and
  steal spawn exit statuses. No observed failure yet; move it inside the
  import.meta.main seam with a soak run of the full suite before landing.
  Effort: S.
- [x] **P2 — CI e2e lane runs only 8 of ~187 e2e files.** DONE (test-gap
  wave, plan G1): the `selected-e2e` PR job in .github/workflows/e2e.yml runs
  the diff-relevant selection from scripts/select-e2e.ts (service Postgres
  only — fork-runnable, no secrets; loud per-file exclusions; schedule
  early-exit), wired into the e2e-status aggregator + cache-write needs.
  test/scripts/e2e-wiring.test.ts ratchets every e2e file into a lane with a
  shrink-only unmapped baseline; the nightly full glob stays the
  schedule-required backstop.
- [ ] **P3 — run-unit-parallel external-kill reporting contradicts itself.**
  A shard killed by an in-suite exit(143) prints `pass=N fail=0` +
  `oom_rescue_failed=0real` in the final banner yet exits 1, and the
  oom-rescue summary line says "real failures confirmed" with fail=0. Make
  the banner name the killed shard + rescue outcome explicitly so the next
  mystery kill is a 1-minute diagnosis instead of a bisect. Effort: S.
- [ ] **P2 — skills.test.ts e2e leaks a git commit into the HOST repo.** During
  the v0.46.8.0 ship gate, the e2e ingest-skill run created a real commit
  ("ingest NovaMind board update transcript") with fixture pages
  (companies/, people/, meetings/) at the WORKSPACE repo root — the test's
  write-through/commit path resolved the host cwd instead of its tmp fixture
  repo, despite run-e2e.sh's HOME isolation. Caught only because a soft reset
  surfaced the staged files. Find the cwd-resolving path in the ingest skill
  lane (likely repo-root fallback when the source local_path isn't threaded),
  fix it to fail closed, and add a run-e2e.sh post-run guard that fails the
  lane if `git status` at the host root gained tracked-file changes. Effort: M.

### Dream oneshot wave — adversarial-review follow-ups (v0.46.19.0)
- [ ] P2 (adversarial F2): a job that dies mid-oneshot-write-phase (wall-clock timeout) releases its idempotency key with a partial ledger; the next nightly's fresh job re-calls the model and can write differently-stemmed siblings next to the survivors (same hash suffix). Window is tiny (writes are DB-fast, chat is sub-budgeted at deadline/4). Consider: route write-phase timeouts to `delayed` when oneshot ledger rows exist, or dedupe at fan-out on existing `-<suffix>` pages.
- [ ] P2 (adversarial F3): a chronically-failing transcript (always times out / deterministic all-writes-failed) releases its key on dead AND suppresses the cooldown stamp — re-triaged and re-paid every nightly. Add a bounded per-content-hash failure counter (N strikes → skip + surface in doctor/advisor).
- [ ] P3 (adversarial F6): legacy direct-Anthropic path with the CDX-6 32k thinking default can exceed the SDK's 10-min default request timeout on slow generations (flag-off deployments only; surfaces as a retryable conn error at full token cost). Set an explicit SDK timeout or cap legacy maxTokens.
- [ ] P3: phase-end `embedStalePages` runs outside BudgetTracker (bounded to the phase's own writes + 120s; fold under the tracker if spend telemetry wants it).

### Recipe routing follow-up (#4292)
- [ ] **P3 — install-time MECE warn for resolver rows.** `gbrain integrations
  install` appends `resolver_rows_to_append` blindly; when an appended row
  shares trigger phrases with an existing resolver row in the host repo
  (e.g. "who is" claimed by both a recipe skill and the query skill), routing
  goes ambiguous with no signal. Warn at install time when a to-append row's
  quoted phrases already appear in the target RESOLVER.md/AGENTS.md. Effort: S.

## Megawave follow-ups (filed from v0.46.28.0, #4475)

- [x] **P2 — #4477: db.ts initSchema legacy blob-replay path lacks
  forward-reference bootstrap.** DONE (v0.46.29.0, #4567): peeled into
  `src/core/postgres-engine/forward-reference-bootstrap.ts`
  (`applyPostgresForwardReferenceBootstrap`), run by BOTH SCHEMA_SQL replay
  entrypoints — `PostgresEngine.initSchema()` and the standalone
  `db.ts:initSchema()`. Pinned by `test/e2e/postgres-bootstrap.test.ts`.
- [x] **P3 — #4478: subagent-crash-replay-multi-provider openrouter matrix
  rows stale.** DONE (v0.46.29.0, #4567): generic openrouter rows pruned
  (the capability gate refuses them before replay; pinned by a dedicated
  refusal describe), and the #4514 Anthropic-via-OR carve-out gets its own
  replay coverage in `test/e2e/openrouter-anthropic-subagent-replay.live.test.ts`
  + `test/e2e/subagent-gateway-path.test.ts`.
- [x] **P3 — #4479: ci-local hardening.** DONE (v0.46.29.0, #4567): (a)
  `docker-compose.ci.yml` pins `oven/bun:${GBRAIN_CI_BUN_TAG:-1.3.14}` to the
  host bun (override per-run to test latest); (b) the upload-path fuzz suite
  chdirs to a guaranteed-deep cwd so the depth-1 `/app` mount can't false-fail
  the `..`-probes; plus a container-lane `GBRAIN_TEST_TIMEOUT_MULTIPLIER=6`.
- [x] **P2 — #4480: deferred review findings from the megawave.** DONE
  (v0.46.29.0, #4567), all three: (a) `take-proposals.ts` accept is now
  claim-first CAS (exactly one caller wins the pending row; best-effort
  rollback on post-claim failure; stranded claimed-but-unpromoted rows get a
  named error); (b) `cjk-keyword-sql.ts` honors `type`/`types`/`exclude_slugs`
  like the main keyword arm; (c) the chat-usage sink is a registry stack with
  deregister-on-disconnect (records route to the top LIVE entry), so a
  multi-engine process no longer loses its ledger to a closed engine.

## Privacy-sweep follow-ups (filed from the remote-privacy-sweep branch)

- [ ] **P2 — write-side privacy sweep (put_page round-trip class).** The
  read-side sweep (`test/remote-privacy-sweep.test.ts`) covers what remote
  callers can READ; it deliberately does not cover the erase-on-write hazard
  class (#2044 family: a remote get_page → edit → put_page round-trip
  silently erasing rows the caller never saw) NOR the write-triggered
  restoration ECHO class (a remote put_page INTO a fence-bearing page whose
  response envelope echoes #2044-restored private rows — the sweep's phase W
  targets fresh slugs only, by design, so an echo requires a dedicated
  harness). Build: put_page round-trips over seeded private corpora with
  response-echo assertions, anchored on `src/core/import-file.ts`'s
  restoration mechanism. **Why now-ish:** the read-side sweep found 4 live
  read leaks on its first runs; the write side has had zero equivalent
  sweep pressure. Effort: M. Depends on: nothing (read-side sweep already
  landed as the pattern to copy).
- [ ] **P2 — source-scope + row-grain hardening for the salience/anomaly/expert
  arms.** Four classes surfaced by the read-side sweep's review and deferred
  from the leak PR because each is a family-wide semantics change: (a)
  `get_recent_salience`/`find_anomalies` never thread `sourceScopeOpts(ctx)`
  into the engine reads (pre-existing v0.34.1 source-isolation class — a
  source-bound remote client sees every source's world rows); (b) the whole
  `findPrivateOnlySlugs` family is slug-grain, so a slug world-in-source-A /
  private-in-source-B serves the PRIVATE row's own title through row-grain
  arms (rows carry source_id — a composite-key filter fixes it, but must land
  family-wide or semantics diverge across ops); (c) the private post-filters
  run AFTER the engine's LIMIT, so remote callers can get fewer than `limit`
  rows while world rows exist below the cutoff (push the
  `privatePagesFilterFragment` predicate into the engine reads, or over-fetch);
  (d) the two unscoped private-visibility probes are slug-only queries
  with no slug-leading index (`pages_source_slug_key` leads on source_id) —
  add a `pages(slug)` btree index when (a)-(c) land; (e) `find_anomalies`
  baselines (`baseline_mean`/`baseline_stddev`) are computed private-inclusive
  in both engines, so a mixed cohort's baseline discloses aggregate private
  activity volume AND a genuinely-anomalous world spike can be suppressed when
  concurrent private activity inflated the baseline — world-only cohort
  aggregation belongs in the same engine pass as (a). Effort: M-L. Depends on:
  nothing, but coordinate with the P3 chokepoint below rather than duplicating.
- [ ] **P3 — runtime chokepoint for world-only filtering.** Privacy is
  enforced per-arm/per-column at N call sites (get_page/fetch strip, delta
  page arm, find_orphans/get_recent_salience/find_anomalies post-filters,
  context_pack/delta include_private gating); each new remote surface leaks
  until someone notices — the class has now recurred five times. Move the
  world-only filter to a single dispatch-layer interceptor (or an
  engine-level read-scope wrapper) so new ops are world-only BY DEFAULT.
  High blast radius: touches every read op; do NOT attempt until both
  sweeps (read-side, landed; write-side, P2 above) are in place as safety
  nets. Effort: L. Depends on: the P2 write-side sweep.

## DB-availability loop follow-ups (filed 2026-08-25, engine-detection / db-repair / prefer-postgres wave)

- [ ] **P3 — `_meta.brain_health` one-shot channel after a successful repair.**
  Today a recovered brain announces itself only via the serve-side
  `tools/list_changed` + the `[gbrain-serve] RECOVERED` stderr line; the AGENT
  facing the brain learns nothing in-band. Add a one-shot `_meta.brain_health`
  block to the FIRST successful op response after a degraded→recovered
  transition (and after a `db-repair` `outcome:'applied'` receipt newer than
  the session start), so the agent can tell the operator "the brain is back,
  here's what was fixed" without polling `engine status`. One-shot per
  transition, never a steady-state field. Effort: S.
- [ ] **P3 — full sslmode handling beyond the ssl_required rewrite.**
  db-repair's `?sslmode=require` append is the repo's FIRST sslmode support
  and deliberately minimal. Missing: parsing/validating an existing `sslmode`
  param (a URL already carrying `sslmode=disable` gets a conflicting
  `&sslmode=require` appended — last-wins works on libpq semantics but is
  ugly), the other modes (`verify-ca`/`verify-full` need CA material we can't
  conjure), and surfacing the effective ssl posture in `engine status`'s
  pooler block. Effort: S-M.
- [ ] **P3 — finish TODOS #1231: doctor `connection_routing` check.**
  `ConnectionManager.describeMode()` and `healthCheck()` now have their first
  real caller (`engine status --probe` reports `mode` + `pool_latency_ms`),
  which retires the "zero-caller outside tests" blocker in the original
  entry. Remaining: the actual doctor check naming the routing mode,
  kill-switch state, and per-pool probe latency (the four files whose
  comments reference the check as if it existed still do). Effort: S.
- [ ] **P3 — generalize the classify→marker→skill→repair loop to other
  subsystems.** The pattern (data-driven reason table + append-only union,
  pre-redacted remediation single-homed in the classifier, a stderr/envelope
  marker literal-matched by a bundled skill, an engine-free repair command
  with tiered flag-gated consent) is proven for Postgres access; the
  embedding-provider/gateway lane has the same "gbrain goes dark with a raw
  error" failure class (429/401/quota/base-url misconfig). Sketch: a future
  `GBRAIN_AI_ACCESS <reason>` marker + `gbrain ai-repair`-shaped diagnose
  surface. Do NOT bolt AI reasons onto `PgAccessReason` — separate union,
  separate marker prefix. Effort: M-L.
- [ ] **P3 — TODOS #1050 (keyless cold-home serve) × `--prefer-postgres`.**
  Degraded-mode serve now covers the "configured brain, dead DB" half of
  #1050 (serve boots and self-heals instead of dying), but the NO-CONFIG
  cold-home half still exits inside `connectEngine` before serve's degraded
  catch (deliberate — there is nothing to reconnect TO). When keyless
  cold-home boot lands, wire it through the same ladder entry
  (`gbrain init --prefer-postgres`) so a first-boot harness lands on the
  best available engine instead of hardcoding PGLite, and re-check the
  init-ladder's existing-config refusal still holds (a cold-home boot must
  not become a config-overwrite vector). Effort: M (blocked on #1050's own
  design). Follow-up from v0.46.31.0.
- [ ] **P3 — scope the CLI bottom-handler's GBRAIN_DB_ACCESS marker to
  engine-originated errors.** The top-level rejection handler classifies
  EVERY uncaught error, and connection-class patterns (ECONNREFUSED,
  getaddrinfo, ETIMEDOUT) also match failures from non-DB dependencies (a
  webhook fetch, an Ollama endpoint, a remote MCP URL) — a false marker
  sends agents into the db-repair skill. Bounded today by the forged-marker
  defense (db-repair probes healthy → exit 0 no-op), but it burns an agent
  loop and the printed `Run: gbrain db-repair` can displace the real
  remediation. Fix shape: tag errors at the engine/connect layer (a symbol
  or error subclass) and emit the marker only for tagged errors; untagged
  errors keep redaction but drop the marker. Effort: M. Follow-up from
  v0.46.31.0 (adversarial review).
- [ ] **P3 — mount-targeted db-repair.** v1 deliberately refuses when the
  brain axis resolves to a non-host mount (a mount outage must never rewrite
  host config) and prints the mount's diagnosis + recipe. The follow-up:
  `gbrain db-repair --brain <mount-id>` that probes and repairs against the
  MOUNT's own config entry (rewrites edit the mounts registry row, receipts
  key on the mount's brain_id — the recurrence check already sums per
  brain_id, so no reader change). Effort: M.
- [ ] **P3 — marker coverage for remaining in-command CLI catch sites.** The
  connect-time choke point (top-level rejection handler + the no-config exit)
  plus sync's checkpoint-dead abort cover the dominant "gbrain went dark"
  class. Embed's HARD DB failures propagate to the bottom choke point (the
  CLI wrapper's `failures > 0` verdict is per-chunk soft failures — mostly
  embedding-provider-side, which the Postgres classifier deliberately does
  not own; that lane is the `GBRAIN_AI_ACCESS` generalization entry above).
  Other in-command catches still print legacy text with no `GBRAIN_DB_ACCESS`
  marker when their failure classifies as a DB-access reason (candidates:
  doctor's non-fallback DB errors mid-run, extract/import bulk loops, jobs
  work loop). Sweep the catch sites, route message text through the
  redactors, and emit the marker where `isDbAccessFailure` says so. Effort: M.

## Test-gap-wave ship-review residuals (filed at ship time; each verified real, deferred with rationale)

- [ ] **P2 — chronicle diary redaction: WHERE-level exclusion for remote callers.**
  The fail-closed redaction filters AFTER the SQL LIMIT, so a remote caller's
  chronicle_day/since/on_this_day response can under-fill (empty day view when
  diary rows saturate the limit) and the row-count deficit is a countable
  oracle for diary VOLUME in the window; chronicle_last_seen answers the
  never-seen shape when the LATEST sighting is diary-sourced instead of
  degrading to the most recent non-diary sighting. Push the diary exclusion
  into the WHERE clause for remote callers in BOTH engines (the epScope
  threading pattern) so the limit applies to visible rows and last_seen
  degrades gracefully. Files: src/core/ops/chronicle.ts, both engines'
  chronicle read queries, test/chronicle-ops-scope.test.ts. Effort: M.
- [ ] **P2 — selected-e2e PR-lane sizing for version-bump PRs.** The
  fail-closed selector treats package.json/bun.lock changes as run-ALL, so
  every /ship PR (version bump) pays the full e2e glob on one runner against
  a 60-min ceiling. Consider: version-only package.json diffs classify as
  doc-like, or shard the full-glob fallback. Constraint: select-e2e's
  --classify-only exit semantics are load-bearing (coverage-diff-gate) — a
  selector semantics change needs its own review. Files:
  scripts/select-e2e.ts, .github/workflows/e2e.yml. Effort: M.
- [ ] **P3 — PACK_NOT_FOUND echoes the resolved baseDir.** Pre-existing
  (deliberately not expanded by the INVALID_PACK_NAME work): the error
  message embeds the absolute schema-packs path and rides verbatim to remote
  admin callers via schema_apply_mutations' envelope. Redact to the pack name
  only, or gate the path to trusted local. Files:
  src/core/schema-pack/mutate.ts. Effort: S.
- [ ] **P3 — find_contradictions probe reports lack endpoint source
  attribution.** The scope pass checks slug existence within scope; findings
  carry no source_id, so a same-slug page in another source can satisfy the
  check (caveat documented at the check site). Record source_id per endpoint
  in the probe report_json and filter on it. Files:
  src/core/eval/contradictions*, src/core/ops/insights.ts. Effort: M.
- [ ] **P3 — consolidate copy-pasted test harnesses.** Five near-identical
  in-process CLI runners (cache-cli/remote-cli/github-source-demo/connect/
  quarantine-cli), four in-process OAuth+MCP fixture servers (remote-cli/
  mcp-client/doctor-remote.serial/init-mcp-only), three subagent auto-cancel
  polling harnesses (dream-quota-degradation/cycle-synthesize-daily-cap/
  e2e dream-synthesize-chunking), six exit-verdict restore blocks in
  sync-delegate-ladder. Extract shared test/helpers modules. Effort: M.
## Wave-K follow-ups (filed from v0.46.30.0 wave-k)

- [ ] **P3 — Wave-orchestration tooling: `scripts/wave-manifest.ts`.**
  **What:** a script that owns the fix-wave snapshot → manifest → absorb
  pipeline (enumerate approved fix branches, emit the ordered pick manifest
  with shas/files/kind, verify each pick's reachability, and record
  absorb/defer outcomes). **Why:** every wave re-derives this by hand —
  pass coordination facts, tsv-ownership rows, and pick order live in ad-hoc
  JSON + prompts, and a transcription slip silently reorders or drops a fix.
  **Context:** follow-up from v0.46.30.0 wave-k; see
  `.context/wave-k/trainB-assembly.json` for the shape a generator should
  emit. **Effort:** M.

- [ ] **P3 — GitHub label-system consolidation.** **What:** collapse the old
  `p0/p1/p2` + `verified-real` label family into the newer `triage:*` scheme
  (one migration pass over open issues, then delete the legacy labels).
  **Why:** wave triage currently matches BOTH families, so a query against
  one family undercounts and severity sorts disagree between tools.
  **Context:** follow-up from v0.46.30.0 wave-k. **Effort:** S.

- [ ] **P2 — PR-triggered full-e2e opt-in label for wave-scale PRs.**
  **What:** a `ci:full-e2e` (name TBD) PR label that runs the full 202-file
  e2e matrix on the PR head instead of waiting for nightly. **Why:** wave
  trains land tens of picks per PR; today the full matrix is nightly-only, so
  a train-wide e2e regression surfaces a day after merge instead of on the
  PR. **Context:** follow-up from v0.46.30.0 wave-k; blocked on
  workflow-scope push credentials (the workflow file change can't ship from
  a fix branch without them). **Effort:** M.

- [ ] **P3 — #4364 verify note: `--list` DB probe misclassifies an empty
  brain.** **What:** `apply-migrations --list`'s probe labels a
  reachable-but-uninitialized DB "UNREACHABLE (relation config does not
  exist)". Classify post-connect query errors (undefined table/relation) as
  connected-uninitialized instead of unreachable. **Why:** the current label
  sends operators debugging connectivity when the fix is `gbrain init`.
  **Context:** follow-up from v0.46.30.0 wave-k, filed by #4364's verifier;
  `src/commands/apply-migrations.ts` probe branch. **Effort:** S.

## Ship-review filings (2026-09-01 eval fix wave, /ship review army)

- [ ] **P3 — lazy OR-fallback rescue in hybridSearch.** **What:** the engines'
  AND→OR keyword/title fallback query still executes on every
  zero-strict-recall search, but its rows are discarded pre-fusion whenever
  the vector arm is healthy (the common case after the #3617 fusion-demotion
  fix) — one wasted FTS round-trip per zero-strict-match query. **How:** fetch
  with orFallback:false on the hot path and re-run the lexical arms with
  orFallback only when every vector list came back empty (the rescue case).
  Rejected in-wave: the arms resolve before the vector arm settles, so the
  restructure touches the fan-out ordering — not a late-wave change.
  **Where:** `src/core/search/hybrid.ts` arm fan-out; engines unchanged.
  **Effort:** M.
- [ ] **P2 — Cat 35 judge-calibration hand-scoring (user-time gate).**
  **What:** the gbrain-evals Cat 35 report's §11 kappa is `[pending]` behind
  ~45 minutes of HUMAN hand-scoring of the 24 committed calibration pairs
  (`docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill/judge-calibration-2026-08-25.json`),
  then `--judge-calibration` computes agreement and the STATUS banner drops.
  Agents cannot do this — it exists to calibrate the judge against a human.
  **Where:** gbrain-evals repo. **Priority:** P2 (publication-quality gate,
  not a number gate).
- [ ] **P2 — BrainBench assistant-role window fidelity (requires rebank).**
  **What:** the bench harness replays USER turns only (`harness.ts` folds
  assistant turns into priorContext), so adapter windows are user-only while
  production `getWindowTurns` windows mixed roles — assistant-introduced
  entities (a designed volunteer input with their own rationale template) are
  exercised as SUPPRESSION input, the inverse of their production role, and
  per-window user-content depth runs ~2x production. **How:** feed assistant
  turns to adapter windows (e.g. an `onNonUserTurn` hook on HarnessAdapter),
  then re-bank every cell + re-derive the 0.95 openclaw floor and token
  ceilings in the SAME commit (hold-or-improve). Filed instead of fixed
  in-wave: changing replay semantics after seeing results violates the
  frozen-measurement rule; the 2026-08 delta is internally valid (baseline
  and fix measured under identical window semantics) and the deviation is
  disclosed in BRAINBENCH.md's seam table. **Where:**
  `src/eval/brainbench/harness.ts`, `adapters/*.ts`. **Effort:** M.
- [ ] **P3 — server-side volunteer-report IPC kind.** **What:** a small IPC
  message the reflex client sends AFTER gating, carrying the volunteered
  survivors, so the serve logs volunteer events on the PGLite/IPC rung
  (today: direct-Postgres rung only) AND the delivery audit stops depending
  on the advisory `isVolunteerProbeShaped` exemption (a deliberate client
  can shape a request as a volunteer probe and receive the wide pool with no
  delivery log line — acceptable while the log is tuning telemetry, not an
  audit control; this closes it). **Where:** `src/mcp/resolve-ipc*.ts`,
  `src/core/context/reflex.ts`. **Effort:** S/M.
- [ ] **P2 — multi-query expansion dilutes small-k retrieval now that fusion
  is clean.** **What:** post-#3617-demotion, the expansion path's variant
  vector lists (equal RRF weight vs the original query's list) actively push
  correct results out of the top-k: LongMemEval RC receipt shows
  hybrid+expansion recall_all@5 49.57% vs plain hybrid 93.19% ON THE SAME RUN
  — 208 questions pass on hybrid and fail on expansion, 3 the reverse; the
  losses span every question type and the mechanism is verified by
  construction (keyword/title/relational arms and the original vector list
  are identical inputs; only variant lists differ; zero expansion errors in
  the run). Pre-fix, variants were net-positive (+6.8pp) because the fusion
  baseline was relaxed-row-poisoned; the marginal value flipped sign when the
  baseline got clean. Production impact: tokenmax mode (expansion on) pays
  Haiku spend for variants that HURT at small k; unmeasured at production
  k=50. **Fix candidates (pre-register one next wave, frozen-corpus rules):**
  weight variant lists below the original in RRF (variant-k penalty), cap
  variant-list contribution, or CRAG-style trigger (expand only when the
  original's recall evidence is weak). **Where:**
  `src/core/search/hybrid.ts` fusion assembly (`allLists`),
  `expansion.ts`. Receipt: gbrain-evals
  `lme-phase6-8bb33cac-k5.{ndjson,json}`. **Effort:** M.
- [ ] **P3 — IPC probe-field version echo.** **What:** a NEW reflex client
  against an OLD long-running `gbrain serve` sends `probe:'volunteer'` that
  the serve ignores, logging the wide ungated pool as delivered pointers on
  every windowed turn until the serve restarts (per-turn ~10-row inflation of
  reflex precision stats). Echo a protocol/feature version in the IPC hello
  and skip probe sends (or the volunteer arm) when the server predates
  `probe`. **Where:** `src/mcp/resolve-ipc*.ts`. **Effort:** S.
- [ ] **P1 — extractor-classified transient TTL for the ambient-writeback
  backstop lane.** **What:** teach the facts extractor an optional `transient`
  boolean (schema + prompt) and let `FactsBackstopCtx` carry a `transientTtl`
  so backstop-extracted transient facts (health/location/travel/mood/near-term
  schedule) get the configured `memory.auto_writeback_transient_ttl` instead
  of being durable. **Why:** today only the instruction path applies the TTL
  (agents pass `ttl` on `remember`); a transient fact caught only by the
  Stop-hook/sweep backstop stays durable until forgotten — a documented
  asymmetry in `docs/guides/ambient-writeback.md` that both cross-model
  reviews flagged as next-release work. **Context:** filed from the
  ambient-writeback wave; the admission seam already exists
  (`notabilityAdmission` in `src/core/facts/extract.ts`); touching the shared
  extractor prompt perturbs every extraction lane, so land with the prompt-
  shape tests updated across sync/put_page/dream/sweep. **Effort:** M.

- [ ] **P3 — opencode ambient-writeback instruction target.** **What:** a
  `kind:'instructions'` harness target for opencode once a user-global
  instruction file is attested (observation run per the [ENG-7] discipline —
  workspace AGENTS.md is its only verified surface today). **Why:** opencode
  sessions currently get the ambient contract only via MCP `instructions`.
  **Context:** ambient-writeback wave follow-up; writer + splice helpers are
  host-agnostic (`src/core/bootstrap/instructions-block.ts`). **Effort:** S
  after the observation run.

- [ ] **P3 — richer brain-audience heuristics for the writeback consent
  nudge.** **What:** per-client human attribution beyond `likely_automation`
  (and possibly repo-visibility as a signal) in
  `src/core/facts/writeback-audience.ts`. **Why:** the v1 classifier is
  deliberately declaration-first + conservative (≥3 distinct non-automation
  clients / 30d); a personal power user with many surfaces or a two-person
  team brain can each land on the wrong side until someone sets
  `brain.audience`. Doctor names the evidence either way. **Context:**
  ambient-writeback wave follow-up. **Effort:** M.

- [ ] **P3 — promote the `$CODEX_HOME/AGENTS.md` + `AGENTS.override.md`
  provisional spec entries to verified.** **What:** an observation run against
  a pinned codex-cli release confirming the user-global AGENTS.md discovery
  ladder and the override-exclusivity rule, then flip the PROVISIONAL notes in
  `src/core/bootstrap/host-specs.ts` to a dated verified target. **Why:** the
  harness `instructions` target and doctor's override probe currently rest on
  documented-but-unobserved behavior (developers.openai.com/codex/guides/
  agents-md, noted 2026-09-01). **Context:** ambient-writeback wave; the
  live door test (`test/e2e/bootstrap-real-codex.serial.test.ts`, ambient-
  writeback describe) is the harness for the run — it already passed once
  against codex on 2026-09-01 (`usedWriteTool=true`). **Effort:** S.

- [ ] **P2 — owner-scoped remote visibility for private facts.** **What:** an
  owner-grade credential tier whose REMOTE `recall`/`context_pack`/`delta`
  reads may include `visibility: 'private'` facts (today remote reads are
  world-only unconditionally; `include_private` is honored solely for
  `remote === false`). **Why:** the ambient-writeback template must currently
  choose between round-trip-able facts (`world`) and operator-private facts
  that the writing agent itself can never recall in a later remote session —
  the F5 unset→world posture is the honest workaround, not the fix. An
  owner-scoped tier would let explicitly-private brains keep ambient facts
  private AND recallable by the owner's own remote agents. **Context:** filed
  from the ambient-writeback wave; touches the trust boundary
  (`docs/protocol/MEMORY_VERBS_v1.md` Trust boundary section — additive
  credential semantics, not a protocol version bump), token scopes
  (`src/core/scope.ts`), and every world-only read ternary
  (`src/core/ops/facts.ts:214`, `src/core/facts/meta-hook.ts:115`,
  context_pack/delta). Needs its own security review. **Effort:** L.

- [ ] **P3 — extractor rule for quoted third-party material.** **What:** teach
  the fact-extraction prompt (`src/core/facts/extract.ts`) to skip claims that
  exist only inside quoted/pasted third-party text, mirroring the instruction
  template's skip-list and the writeback gate's `quoted_or_tool_output` rule.
  **Why:** the Stop-hook gate strips quotes only for CLASSIFICATION — a
  substantive turn that also contains quoted material banks the full
  (secret-scanned) text, and the extractor currently has no quoted-material
  exclusion; secrets are covered by redaction, but non-secret third-party
  claims can land as user facts. **Context:** residual from the
  ambient-writeback wave (v0.47.10.0); deliberately deferred because prompt
  changes perturb EVERY extraction lane and need an eval pass
  (`docs/eval/`). **Effort:** M.

- [ ] **P3 — align the BrainBench continuity metric with read-time TTL
  validity.** **What:** `src/eval/brainbench/metrics/continuity.ts:70` still
  counts rows whose `valid_until` has lapsed; the engines' facts-health
  active bucket no longer does. **Why:** the eval metric and
  `getFactsHealth` should measure the same "active" definition or the
  continuity score silently drifts from what users see. **Context:** filed
  from the ambient-writeback wave (v0.47.10.0, read-time validity).
  **Effort:** S.

- [ ] **P3 — `volunteer_channels` quiet-channel guidance predates the
  engine-uniform IPC listener.** **What:** the non-PGLite branch in
  `src/commands/doctor/checks/core-health.ts` (~line 339) still tells
  Postgres operators "the harness-hook channels require a PGLite serve
  socket — quiet by design", but #4245 made the listener engine-uniform
  (`resolveSocketPathForConfig` keys a run-dir socket off the connection
  URL; Postgres serves bind it). **Why:** a Postgres operator with a live
  serve gets told their quiet hook lane can never fire when the real fix is
  "start/restart a serve for this brain and re-register". Update the
  guidance to the serve-liveness framing (and re-check the matching
  `volunteer_channels` passage in `docs/architecture/KEY_FILES.md`, which
  mirrors the code's current wording). **Context:** surfaced by the
  v0.47.10.0 doc audit — `docs/guides/bootstrap.md`'s Postgres row and
  `docs/guides/ambient-writeback.md` were corrected to the engine-uniform
  truth; this is the remaining code-side echo. **Effort:** S.
