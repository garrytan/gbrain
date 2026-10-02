# Evidence — dead-module clusters (misc, progressive-batch, calibration, minions) + orphan named-set ratchet

Base: master a6eca5e (v0.59.17.0). Ingestion cluster and `src/core/source-config-redact.ts` HELD by instruction (untouched).

## Disposition gate

(a) Reachability at base. `node scripts/check-orphan-modules.mjs` at a6eca5e: `45/46 test-only-reachable`, same 45 modules as the lane report (30 cluster + 7 ingestion + source-config-redact + 7 script-used). No cluster module gained a runtime caller. Poison probe: `throw new Error("POISON_PROBE <path>")` prepended to all 30 cluster modules, then `bun src/cli.ts --version` (rc 0), `bun src/cli.ts --help` (rc 0), `await import()` of all 31 other runtime entries and package exports (mcp/server, openclaw-context-engine, admin-embedded, agent-install/entry and every `package.json#exports` target: all rc 0), and `bun build <all entries> --packages external` (rc 0; `grep -rl POISON_PROBE` over the bundle: no match; bundle includes lazily imported commands, e.g. `runDream`). Reverted.

(b)/(c)/(d) One disposition per module:

| Module | Callers ever (git log -G on src/ imports) | User-facing promise found | Disposition |
|---|---|---|---|
| data-research.ts | none since v0.10.0 | skills/data-research is pure markdown; names no code | intentionally abandoned |
| fail-improve.ts | none since v0.10.0 | skill-autobench uses the taxonomy only ("taxonomy only" upstream note) | intentionally abandoned |
| eval-capture-graph.ts | none since v0.34.0.0 ("W7 capture wiring" left in v0.34.1 backlog) | skills/migrations/v0.34.0.0.md W7 bullet (annotated) | intentionally abandoned |
| commands/eval-schema-authoring.ts | never dispatched (v0.48.4.0 E4 kept it pending T16) | none (no CLI dispatch); TODOS T16 items reworded to rebuild from history | intentionally abandoned |
| artifact/index.ts | none since v0.39.1.0 | none | intentionally abandoned |
| distribution/index.ts | none since v0.39.1.0 (re-export barrel) | none | intentionally abandoned |
| diarize/payload-fitter.ts | none since v0.39.0.0 | TODOS "judges.ts → payload-fitter delegation" (closed; judges.ts keeps its own loop); incident doc annotated | intentionally abandoned |
| conversation-parser/llm-polish.ts | none since v0.41.16.0; config.ts documented "polish scaffold remains unwired" | docs/operations/conversation-parser-llm-fallback.md sentence (removed) | intentionally abandoned |
| enrichment/budget.ts (BudgetLedger) | none since v0.13.0 | design doc only; TODOS claim "backs gbrain enrich" false (`gbrain enrich` uses src/core/budget/budget-tracker.ts `BudgetTracker`) — closed. `budget_ledger` migration kept | intentionally abandoned |
| enrichment/completeness.ts | none since v0.16.0 | design doc; enrichable.ts comments (fixed) | intentionally abandoned |
| upgrade-checkpoint.ts | none since v0.30.1 | `gbrain upgrade --resume` promised only in the module header and CHANGELOG v0.30.1 (line ~23727/23744); no README/docs/help/skills promise; `--resume` absent from src/commands/upgrade.ts | intentionally abandoned (CHANGELOG note needed) |
| schema-pack/expand-type-filter.ts | none since v0.41.22.0 | skills/schema-unify/SKILL.md (2 sites) — corrected to describe the live alias closure | superseded by `expandEngineTypeFilters` (src/core/schema-pack/query-types.ts, used by ops/search.ts and search/hybrid.ts): gbrain-base-v2 `media` declares `article` as alias, so `--type article` still returns the pages (superset incl. other media) |
| schema-pack/rewrite-links-batch.ts | none since v0.41.22.0 | canonical-writers.tsv row (removed) | intentionally abandoned |
| skillpack/brain-pack-lint.ts | never wired into init-brain-pack (v0.42.47.0) | CHANGELOG v0.42.47 claim; scaffold SKILL.md comment "used by the version-skew lint" (corrected in init-brain-pack.ts); TODOS note corrected | intentionally abandoned (CHANGELOG note needed) |
| archive-crawler-config.ts | none since v0.25.1 (skill is pure markdown) | skills/archive-crawler/SKILL.md: safety fence "enforced by src/core/storage-config.ts" (false) | **HOLD** (required-but-unwired security fence claim) |
| chronicle/backstop.ts | live in put_page until **v0.51.0.0 (d13aa742f)** removed it during the durable-writes refactor (facts-backstop moved to the effects queue; chronicle dropped, commit message silent) | CHANGELOG v0.42.56 "turn it on with `gbrain config set auto_chronicle true`"; advisor tells users "enable auto_chronicle"; `isAutoChronicleEnabled` has no other reader → setting is a no-op | **HOLD** (accidental drop = bug) |
| onboard/impact-capture.ts | never wired (T12/T13/T15 integration never landed) | `gbrain onboard --history` (CHANGELOG v0.41.18) reads `migration_impact_log`; this module is its only writer → always empty | **HOLD** (required-but-unwired) |
| progressive-batch/{orchestrator,retrofit-wrap,stage-report}.ts | 3 retrofit sites landed in #1510 (f702ec053) and were removed an hour later by #1519 (8ab733471) merge resolution; TODOS.md:4541 records "The merge took ours (workers)" with an OPEN "re-compose progressive-batch + workers on the 3 reindex sites" item, plus open 9-site retrofit item (TODOS.md:4579) | doctor `progressive_batch_audit_health` reads an audit nothing writes; post-upgrade-reembed.ts:120-131 comment claims reindex writes it | **HOLD** pending parent decision (deliberate merge choice with open rewire TODO; not an accidental drop) |
| calibration/take-forecast.ts, recall-footer.ts, cross-brain.ts, nudge.ts; eval-contradictions/calibration-join.ts | none since v0.36.1.0 | CHANGELOG v0.36.1.0 E3/E5/E7/E8/T16 claims (stderr nudge, forecast blurb, contradiction tags, cross-brain sharing, `gbrain takes nudge --reset` — that CLI does not exist); skills/conventions/calibration.md "Cross-brain semantics (D18)" + "`canReadMountsForCtx()`" (that function exists nowhere) — corrected; plugin trees regenerated. `take_nudge_log` migration kept | intentionally abandoned (CHANGELOG note needed) |
| minions/budget-tracker.ts | none (only self-fix.ts, itself dead) | no `--budget-usd` flag on `gbrain jobs`; CHANGELOG v0.41.0 | superseded: live delegated-subagent spend cap is `withDelegatedSpend` → `src/core/minions/budget-meter.ts reserve/settle` (per-client daily cap, `pg_advisory_xact_lock` + reservation before each call = same bounded-overspend reservation property, keyed on client/day instead of batch owner) plus in-process `src/core/budget/budget-tracker.ts` via the gateway |
| minions/self-fix.ts | none | `minions.self_fix_max_depth` read nowhere | intentionally abandoned |
| minions/lease-cap-controller.ts | none | none (harness `scripts/e5-lease-cap-ab.ts` never imported it; deleted with its fixture) | intentionally abandoned |
| minions/batch-projection.ts | none | none (`gbrain jobs submit` prints no projection) | intentionally abandoned |
| minions/stagger.ts | none since v0.13.0 | cron-scheduler skill uses an agent-level 5-minute rule, not this hash; `stagger_key` not exposed by CLI/ops. Migration kept | intentionally abandoned |

## Deleted tests and dead mixed-file portions

| Deleted test | Case | Probe / evidence | Surviving owner | Owner result |
|---|---|---|---|---|
| 21 pure unit/serial files + 3 E2E files (minions-budget-cathedral, minions-controller-bounce-only, minions-self-fix-flow) for the 24 deleted modules | abandoned contract | poison probe above: only these tests detect the modules; every runtime entry unaffected; promises per table above | none needed (no runtime contract) | n/a |
| company-brain-schema: `expandTypeFilter('product').canonical` assertion | abandoned (dead helper property) | helper had no caller | same test's `expandClosure('company'/'product')` lines own the live closure | pass |
| skillpack-init-brain-pack: `lintBrainPackTools (E6)` describe (2 cases) | abandoned | lint never invoked by init-brain-pack | scaffolder cases in same file | pass |
| minions-quiet-hours: `staggerMinuteOffset` describe (5 cases) | abandoned | stagger offset never applied | v12 migration cases (stagger_key column + index) kept | pass |
| silent-abort-3516: "BudgetExhausted from the UNRELATED minions class" | vacuous after deletion | the confusable second `BudgetExhausted` class no longer exists | same file's classifyAbortError cases | pass |
| regressions/v0.36.1.0-iron-rule: R2 block | vacuous | pinned only the unwired calibration-join helper; contradictions output cannot change | n/a (PR 2 deletes the file whole) | pass |
| e2e/schema-cathedral: T22d block | abandoned | artifact abstraction never wired | rest of file | pass |
| e2e/v030_1-integration-pglite: Lane E (4 cases) | abandoned | upgrade-checkpoint never wired; no `--resume` | Lanes A-D (PR 3 deletes the file whole) | pass |
| e2e/jobs-watch-readsnapshot: fixture writer `setOwnerBudget` replaced by direct SQL | retained contract (readSnapshot budget_owners query) | mutation `budget_owner_job_id = mj.id` → `<> mj.id` in src/commands/jobs-watch.ts | the same test | FAILED under mutation (1 fail), passes restored |

## Orphan ratchet (named permitted set)

Before (MAX_TEST_ONLY_REACHABLE=46, 45 test-only): the 45 modules in (scratch) testonly-before.txt.
After (21 named entries, 0 ceiling): 7 script-reachable (bootstrap/template-repo, eval-contradictions/fixture-redact, eval/longmemeval/diagnostics, eval/longmemeval/evidence-packet, eval/shared/autocut-replay, mcp/http-transport, mcp/tool-catalog), source-config-redact (held), 7 ingestion (held), archive-crawler-config, chronicle/backstop, onboard/impact-capture, progressive-batch/{orchestrator,retrofit-wrap,stage-report} (held with reasons). Hard-orphan allowlist of 4 unchanged.

| Guard rule test | Probe edit | Result |
|---|---|---|
| unpermitted-test-only (incl. delete-one-add-one swap) | `const unpermitted = []` | 2 tests FAIL |
| stale-permitted-entry (deleted module) | skip the `!srcSet.has(path)` branch | 1 test FAILS |
| stale script-reachable tag | skip the script-reachable branch | 1 test FAILS |
| guard-self-test | bad fixture (hard orphan) → exit 1, good fixture (permitted test-only + script-reachable) → exit 0 | ok |

Guard runtime on the full corpus: 0.53 s wall (no network).
