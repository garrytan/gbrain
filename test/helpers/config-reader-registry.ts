/**
 * Typed registry for test/config-reader-keys-registered.test.ts (#6780).
 *
 * The guard requires every `getConfig(<key>)` under src/ to name a key
 * `gbrain config set` accepts (KNOWN_CONFIG_KEYS or KNOWN_CONFIG_KEY_PREFIXES).
 * This file holds the two exceptions, each with a reason a reviewer can check:
 *
 * - INTERNAL_CONFIG_STATE: keys and key prefixes gbrain writes itself
 *   (markers, cursors, caches, receipts, counters). Operators do not set them
 *   with `config set`; registering them would advertise a knob that is not one.
 * - UNRESOLVED_CONFIG_READS: call sites whose key is not statically resolvable.
 *   `why: 'parameter'` is verified by the guard (the argument still resolves to
 *   a function parameter); any other reason names where the keys come from.
 *
 * A user-facing knob never belongs here: register it in
 * src/core/config-runtime-keys.ts (or its home list in src/core/config.ts).
 */

export interface InternalConfigState {
  /** An exact key, or a key prefix when `prefix` is true. */
  key: string;
  prefix?: true;
  reason: string;
}

export const INTERNAL_CONFIG_STATE: readonly InternalConfigState[] = [
  { key: 'dedupe.exa_spent_usd', reason: 'the running total gbrain dedupe --exa has paid Exa (entities/evidence/exa.ts); the total cap dedupe.exa_total_cap_usd is checked against it' },
  { key: 'dedupe.exa_cache.', prefix: true, reason: 'one cached Exa answer per query hash (entities/evidence/exa.ts), so a query is never paid for twice' },
  { key: 'dedupe.auto.', prefix: true, reason: 'the per-class switch gbrain dedupe auto --off/--on writes (entities/evidence/auto.ts, dedupe.auto.c2 and dedupe.auto.c7); planAutoLinks reads it' },
  { key: 'version', reason: 'schema version stamp written by migrate.ts' },
  { key: 'correct.receipt.', prefix: true, reason: 'one receipt per correction (rules/correct.ts): which step a correct call reached and what is next; written only by correct, gbrain rules approve and retire' },
  { key: 'policy.approved.', prefix: true, reason: 'the owner-approved agent policy record per scope (policy/store.ts); written only by an owner-confirmed gbrain policy command, refused to config set' },
  { key: 'transcripts.archive.pinned_timezone.', prefix: true, reason: 'the timezone the conversation archive pinned for a source on its first run (transcripts/archive.ts); a hand edit would re-slice every archived day' },
  { key: 'transcripts.archive.audience.', prefix: true, reason: 'the audience (personal or shared) the conversation archive last ran under per source (transcripts/archive.ts); it decides when earlier pages are kept to the owner' },
  { key: 'transcripts.archive.rescope_capped.', prefix: true, reason: 'the number of archive folders when the owner-only re-scope passed the per-source rule limit and kept the whole conversations/ folder to the owner instead (transcripts/archive.ts); status and doctor report it' },
  { key: 'transcripts.archive.last_maintenance', reason: 'the conversation archive\'s maintenance-pass record (transcripts/archive-maintenance.ts); doctor transcript_archive_freshness reads it, so a hand edit would misreport the archive' },
  { key: 'transcripts.archive.backfill_state', reason: 'whether the maintenance pass has finished backfilling older conversation days (transcripts/archive-maintenance.ts); a hand edit would stop or restart the backfill' },
  { key: 'transcripts.archive.last_read.', prefix: true, reason: 'what the last conversation archive run read from each reader per source (transcripts/archive.ts): status and doctor report it as of that run instead of reading every session again' },
  { key: 'transcripts.archive.index_pending.', prefix: true, reason: 'days whose conversation archive day index still has to be written (transcripts/archive.ts); the next run retries them' },
  { key: 'onboarding.first_session', reason: 'the first-session suggestion record (onboard/first-session.ts): reservations, delivered sessions and the stop; written only through its compare-and-set, and a hand edit would re-arm or miscount the suggestion' },
  { key: 'onboarding.install_receipt', reason: 'the install receipt gbrain setup writes when it creates a brain (onboard/setup-history.ts): whether the history import may be offered and what it decided; a hand edit would offer the import on a brain setup did not create' },
  { key: 'learning.keyless_thin_contacts', reason: 'on a keyless brain, the number of thin pages the owner has recent contact with and what filling them would cost, as the last learning_derive pass counted them (learning/derive.ts); learned reads it, so a hand edit would misreport the note' },
  { key: 'learning.derive.watermark', reason: 'the newest row time the nightly learning_derive pass has already recorded into the learning ledger (learning/derive.ts); a hand edit would skip items or record them twice' },
  { key: 'maintenance.last_run', reason: 'the free-upkeep run record (steps, cursor, parked items, next due time) that maintenance/run.ts writes after each gbrain maintain --unattended run; maintain --status and doctor read it, so a hand edit would misreport upkeep' },
  { key: 'enrich_thin.daily_spend', reason: 'the enrich_thin phase\'s running total for the owner\'s day ({day, spent_usd, pages}, cycle/enrich-thin.ts); the daily caps read it, so a hand edit would let the phase spend past cycle.enrich_thin.max_daily_cost_usd or max_daily_pages' },
  { key: 'maintenance.embed_spend', reason: 'the per-day dollar total the capped upkeep embed step has spent (maintenance/run.ts); the daily cap reads it, so a hand edit would let upkeep spend past maintenance.embed_daily_usd' },
  { key: 'heal.audit', reason: 'the bounded self-heal audit log (last 200 rows, 30 days) that heal-audit.ts writes for each heal; doctor reads it to count a heal\'s consecutive failures, so a hand edit would hide an escalation' },
  { key: 'access.serves_derived', reason: 'whether two or more members are enabled, kept by the v309 trigger on access_members (search/private-visibility.ts servesPolicyFrom); a hand edit would lie about whom the brain serves' },
  { key: 'access.serves_since', reason: 'when the brain first served several people, set once by the v309 trigger and never cleared; it starts the unscoped-read grace (access/requester-scope.ts)' },
  { key: 'access.restrictions_present', reason: 'sticky member-access marker a v282 trigger sets once a page names readers or a member exists (search/private-visibility.ts); clearing it would send remote reads down the unrestricted fast path' },
  { key: '_internal.link_extraction_generation', reason: 'link-extraction watermark generation (link-extraction-watermark.ts)' },
  { key: 'code.cluster_generation', reason: 'code-intel traversal cache generation counter' },
  { key: 'embedding_migration.state', reason: 'gbrain migrate-embeddings resume state' },
  { key: 'embedding_migration.completed', reason: 'gbrain migrate-embeddings completion marker' },
  { key: 'embed.backfill_skip_reported', reason: 'once-only marker for the embed_backfill_skipped notice on a keyless brain (embed-backfill-submit.ts)' },
  { key: 'facts.drain_state', reason: 'facts drain scheduler state (facts/drain.ts)' },
  { key: 'facts.absorb_retry.state', reason: 'dead facts-absorb re-submit set (facts/dead-absorb-retry.ts); gbrain facts retry-dead edits it' },
  { key: 'google.file_modes_notice', reason: 'one-time upgrade notice marker (v0.60.31 migration)' },
  { key: 'notices.behavior_changes.http', reason: 'behavior-change notice shown-marker for serve --http' },
  { key: 'ocr_attempted', reason: 'image-OCR run counter (import-file.ts), read by doctor queue_assets' },
  { key: 'ocr_succeeded', reason: 'image-OCR run counter (import-file.ts), read by doctor queue_assets' },
  { key: 'ocr_failed_no_key', reason: 'image-OCR run counter (import-file.ts), read by doctor queue_assets' },
  { key: 'ocr_failed_other', reason: 'image-OCR run counter (import-file.ts), read by doctor queue_assets' },
  { key: 'ocr_skipped_budget', reason: 'image-OCR run counter (import-file.ts), read by doctor queue_assets' },
  { key: 'page_state.revision_backfill', reason: 'page-state revision backfill progress marker' },
  { key: 'schema_migration_timeout', reason: 'the last schema migration that ran out of its statement budget, written and cleared by migrate.ts (migration-timeout.ts, #7108)' },
  { key: 'persistence.database_only_sources', reason: 'list maintained by gbrain sources writer activate/deactivate; config unset (which takes any key) is the documented escape hatch' },
  { key: 'persistence.maintenance.last_compaction', reason: 'receipt compaction pass cursor (compaction-pass.ts)' },
  { key: 'persistence.true_up.compacted_through', reason: 'receipt true-up cursor (receipt-true-up.ts)' },
  { key: 'sync.metafile_pages.applied.', prefix: true, reason: 'per-source marker of the sync.metafile_pages mode a classic sync last applied, so a flip to typed backfills once (sync-metafile-pages.ts)' },
  { key: 'sync.slug_root_mode', reason: 'legacy unsourced slug-root mode stamped by sync (sync-anchor.ts); sourced brains keep it on the sources row' },
  { key: 'transcripts.secret_audit', reason: 'cached transcript secret-audit result (transcripts/secret-audit.ts)' },
  { key: 'trust.backfill_completed_at', reason: 'memory-trust backfill completion marker' },
  { key: 'trust.kill_switch', reason: 'receipt written by gbrain trust disable/enable --all' },
  { key: 'schema_pack.source.', prefix: true, reason: 'per-source schema pack binding written by gbrain schema commands' },
  { key: 'backfill.', prefix: true, reason: 'resumable backfill checkpoints (backfill-base.ts checkpointKey)' },
  { key: 'shared_skills.export.v1.', prefix: true, reason: 'shared-skills migration export receipts' },
  { key: 'shared_skills.content.v1.', prefix: true, reason: 'shared-skills content setup state per source incarnation' },
  { key: 'shared_skills.migration.v1.', prefix: true, reason: 'shared-skills migration checkpoints per source incarnation' },
  { key: 'shared_skills.migration.v1', reason: 'the shared-skills migration report the 0.53.0 migration writes and apply-migrations --list / doctor read for host work (#6796)' },
  { key: 'shared_skills.bridge_owner.v1.', prefix: true, reason: 'shared-brain bridge ownership claims' },
];

/**
 * A template-built key whose leaves are each registered in KNOWN_CONFIG_KEYS
 * (the guard checks that at least one registered key carries the prefix).
 */
export const ENUMERATED_TEMPLATE_PREFIXES: readonly { prefix: string; reason: string }[] = [
  { prefix: 'shared_skills.inventory.', reason: 'inventoryLimitKey(name): the four shared_skills.inventory.* leaves are registered' },
];

export interface UnresolvedConfigRead {
  file: string;
  /** The getConfig argument's source text, whitespace-collapsed. */
  expr: string;
  why: 'parameter' | string;
}

const P = 'parameter' as const;

export const UNRESOLVED_CONFIG_READS: readonly UnresolvedConfigRead[] = [
  { file: 'src/commands/autopilot/install-consent.ts', expr: 'k', why: P },
  { file: 'src/commands/config.ts', expr: 'key', why: 'gbrain config get <key>: the operator names the key' },
  { file: 'src/core/heal-audit.ts', expr: 'key', why: P },
  { file: 'src/commands/decide/probe-query.ts', expr: 'key', why: P },
  { file: 'src/commands/doctor/checks/keyword-plan.ts', expr: 'key', why: P },
  { file: 'src/commands/doctor/checks/sync-config-keys.ts', expr: 'key', why: P },
  { file: 'src/commands/doctor/checks/timeline-history.ts', expr: 'key', why: P },
  { file: 'src/commands/doctor/probe-consent.ts', expr: 'key', why: P },
  { file: 'src/commands/doctor/skill-checks.ts', expr: 'key', why: P },
  { file: 'src/commands/init-mode-picker.ts', expr: 'k', why: P },
  { file: 'src/commands/models.ts', expr: 'overrideKey', why: 'per-task model override key from the model-tier table (models.* prefix)' },
  { file: 'src/commands/search.ts', expr: 'parts[3]', why: 'search tune --apply re-reads the key its recommendation just wrote, to reconcile a thrown write (search.* knobs from tune-recommendations.ts apply_command)' },
  { file: 'src/commands/skillpack/harness.ts', expr: 'key', why: P },
  { file: 'src/core/advisor/collect-setup-smells.ts', expr: 'key', why: P },
  { file: 'src/core/config-db-merge.ts', expr: 'key', why: 'listConfigKeys walk filtered to the cycle. and provider_chat_options. prefixes' },
  { file: 'src/core/config.ts', expr: 'key', why: P },
  { file: 'src/core/connectors/sync.ts', expr: 'key', why: P },
  { file: 'src/core/connectors/sync.ts', expr: 'key', why: P },
  { file: 'src/core/consent-cli.ts', expr: 'key', why: P },
  { file: 'src/core/content-repair/llm.ts', expr: 'key', why: P },
  { file: 'src/core/cycle/auto-think.ts', expr: 'key', why: P },
  { file: 'src/core/cycle/base-phase.ts', expr: 'this.budgetUsdKey', why: 'the subclass budget key: cycle.propose_takes.budget_usd, cycle.grade_takes.budget_usd, cycle.calibration_profile.budget_usd (registered in config-runtime-keys.ts)' },
  { file: 'src/core/cycle/extract-atoms-cost-gate.ts', expr: 'key', why: 'listConfigKeys walk over ATOMS_NO_PRICING_KEY_PREFIX (cycle. prefix)' },
  { file: 'src/core/cycle/nightly-probe-routes.ts', expr: 'key', why: 'Object.entries walk over NIGHTLY_PROBE_SLOT_KEYS' },
  { file: 'src/core/cycle/nightly-probe-search-config.ts', expr: 'key', why: 'walk over NIGHTLY_PROBE_SEARCH_CONFIG_KEYS (search. prefix)' },
  { file: 'src/core/cycle/pattern-grounding.ts', expr: 'key', why: P },
  { file: 'src/core/cycle/patterns-plan.ts', expr: 'cadenceKey', why: P },
  { file: 'src/core/cycle/patterns.ts', expr: 'keys.evidence', why: 'patterns cooldown stamp key from its keys bag (dream. prefix)' },
  { file: 'src/core/cycle/patterns.ts', expr: 'key', why: P },
  { file: 'src/core/cycle/patterns.ts', expr: 'key', why: P },
  { file: 'src/core/cycle/phase-config-values.ts', expr: 'key', why: P },
  { file: 'src/core/cycle/propose-takes.ts', expr: 'key', why: P },
  { file: 'src/core/cycle/synthesize.ts', expr: 'key', why: P },
  { file: 'src/core/cycle/synthesize.ts', expr: 'key', why: P },
  { file: 'src/core/eligibility/policy.ts', expr: 'key', why: P },
  { file: 'src/core/embed-backfill-submit.ts', expr: 'key', why: P },
  { file: 'src/core/embed-consent.ts', expr: 'key', why: P },
  { file: 'src/core/facts/extract.ts', expr: 'key', why: P },
  { file: 'src/core/feedback/settings.ts', expr: 'key', why: P },
  { file: 'src/core/fence-repair/config.ts', expr: 'key', why: P },
  { file: 'src/core/fence-repair/config.ts', expr: 'key', why: P },
  { file: 'src/core/generations/config.ts', expr: 'bound.key', why: 'readGenerationsConfig walk over GENERATION_BOUNDS (the five generations.* keys, each registered in KNOWN_CONFIG_KEYS)' },
  { file: 'src/core/import-file.ts', expr: 'key', why: P },
  { file: 'src/core/import-screen.ts', expr: 'key', why: P },
  { file: 'src/core/line-grammar.ts', expr: 'key', why: P },
  { file: 'src/core/line-grammar.ts', expr: 'key', why: P },
  { file: 'src/core/line-grammar.ts', expr: 'key', why: P },
  { file: 'src/core/mentions/policy.ts', expr: 'k', why: P },
  { file: 'src/core/migration-ledger.ts', expr: 'key', why: 'Object.entries walk over MIGRATION_OPT_OUT_KEYS' },
  { file: 'src/core/minions/admission.ts', expr: 'key', why: 'listConfigKeys walk under the minions. prefix' },
  { file: 'src/core/model-config.ts', expr: 'opts.configKey', why: 'model-tier resolver option; callers pass models.* keys' },
  { file: 'src/core/model-config.ts', expr: 'opts.deprecatedConfigKey', why: 'model-tier resolver option; callers pass legacy model keys' },
  { file: 'src/core/model-config.ts', expr: 'opts.deprecatedConfigKey', why: 'model-tier resolver option; callers pass legacy model keys' },
  { file: 'src/core/pace-mode.ts', expr: 'k', why: P },
  { file: 'src/core/page-body/limits.ts', expr: 'key', why: P },
  { file: 'src/core/persistence/group-publish.ts', expr: 'name', why: P },
  { file: 'src/core/persistence/memory-proposals.ts', expr: 'spec.key', why: 'Object.entries walk over PROPOSAL_LIMIT_KEYS (registered in config-runtime-keys.ts)' },
  { file: 'src/core/persistence/page-mutations.ts', expr: 'name', why: P },
  { file: 'src/core/persistence/sync-drain.ts', expr: 'key', why: P },
  { file: 'src/core/persistence/sync-group.ts', expr: 'key', why: P },
  { file: 'src/core/persistence/worktree-refresh.ts', expr: 'key', why: P },
  { file: 'src/core/pglite-engine.ts', expr: 'key', why: P },
  { file: 'src/core/planner-stats.ts', expr: 'key', why: P },
  { file: 'src/core/postgres-engine.ts', expr: 'key', why: P },
  { file: 'src/core/questions/auto-think-migration.ts', expr: 'key', why: P },
  { file: 'src/core/questions/auto-think-migration.ts', expr: 'key', why: P },
  { file: 'src/core/questions/phase.ts', expr: 'key', why: P },
  { file: 'src/core/reindex-consent.ts', expr: 'key', why: P },
  { file: 'src/core/rust-engine/store-members/config.ts', expr: 'key', why: P },
  { file: 'src/core/rust-engine/store-members/stats.ts', expr: 'brain', why: P },
  { file: 'src/core/rust-engine/store-members/stats.ts', expr: 'brain', why: P },
  { file: 'src/core/search/evidence-delivery.ts', expr: 'key', why: P },
  { file: 'src/core/search/evidence-delivery.ts', expr: 'input.configKey ?? RETURN_UNIT_CONFIG_KEY', why: 'per-op return-unit key option (search. prefix), else the registered default' },
  { file: 'src/core/search/mode.ts', expr: 'k', why: P },
  { file: 'src/core/search/page-rank-cut.ts', expr: 'key', why: P },
  { file: 'src/core/skillopt/cycle-phase.ts', expr: 'key', why: P },
  { file: 'src/core/skillpack/preconditions.ts', expr: 'key', why: 'skillpack precondition config:<key>: the skill names the key' },
  { file: 'src/core/sync-config-keys.ts', expr: 'key', why: P },
  { file: 'src/core/think/pages-budget.ts', expr: 'key', why: P },
  { file: 'src/mcp/publish-gates.ts', expr: 'key', why: P },
];
