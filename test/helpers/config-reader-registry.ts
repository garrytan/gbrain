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
  { key: 'version', reason: 'schema version stamp written by migrate.ts' },
  { key: '_internal.link_extraction_generation', reason: 'link-extraction watermark generation (link-extraction-watermark.ts)' },
  { key: 'code.cluster_generation', reason: 'code-intel traversal cache generation counter' },
  { key: 'embedding_migration.state', reason: 'gbrain migrate-embeddings resume state' },
  { key: 'embedding_migration.completed', reason: 'gbrain migrate-embeddings completion marker' },
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
  { key: 'persistence.database_only_sources', reason: 'list maintained by gbrain sources writer activate/deactivate; config unset (which takes any key) is the documented escape hatch' },
  { key: 'persistence.maintenance.last_compaction', reason: 'receipt compaction pass cursor (compaction-pass.ts)' },
  { key: 'persistence.true_up.compacted_through', reason: 'receipt true-up cursor (receipt-true-up.ts)' },
  { key: 'sync.slug_root_mode', reason: 'legacy unsourced slug-root mode stamped by sync (sync-anchor.ts); sourced brains keep it on the sources row' },
  { key: 'transcripts.secret_audit', reason: 'cached transcript secret-audit result (transcripts/secret-audit.ts)' },
  { key: 'trust.backfill_completed_at', reason: 'memory-trust backfill completion marker' },
  { key: 'trust.kill_switch', reason: 'receipt written by gbrain trust disable/enable --all' },
  { key: 'schema_pack.source.', prefix: true, reason: 'per-source schema pack binding written by gbrain schema commands' },
  { key: 'brainstorm.domain_bank.prefixes:', prefix: true, reason: 'brainstorm domain-bank prefix cache' },
  { key: 'backfill.', prefix: true, reason: 'resumable backfill checkpoints (backfill-base.ts checkpointKey)' },
  { key: 'shared_skills.export.v1.', prefix: true, reason: 'shared-skills migration export receipts' },
  { key: 'shared_skills.content.v1.', prefix: true, reason: 'shared-skills content setup state per source incarnation' },
  { key: 'shared_skills.migration.v1.', prefix: true, reason: 'shared-skills migration checkpoints per source incarnation' },
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
  { file: 'src/commands/decide/probe-query.ts', expr: 'key', why: P },
  { file: 'src/commands/doctor/checks/keyword-plan.ts', expr: 'key', why: P },
  { file: 'src/commands/doctor/checks/sync-config-keys.ts', expr: 'key', why: P },
  { file: 'src/commands/doctor/checks/timeline-history.ts', expr: 'key', why: P },
  { file: 'src/commands/doctor/probe-consent.ts', expr: 'key', why: P },
  { file: 'src/commands/doctor/skill-checks.ts', expr: 'key', why: P },
  { file: 'src/commands/init-mode-picker.ts', expr: 'k', why: P },
  { file: 'src/commands/models.ts', expr: 'overrideKey', why: 'per-task model override key from the model-tier table (models.* prefix)' },
  { file: 'src/commands/skillpack/harness.ts', expr: 'key', why: P },
  { file: 'src/core/advisor/collect-setup-smells.ts', expr: 'key', why: P },
  { file: 'src/core/config-db-merge.ts', expr: 'key', why: 'listConfigKeys walk filtered to the cycle. and provider_chat_options. prefixes' },
  { file: 'src/core/config.ts', expr: 'key', why: P },
  { file: 'src/core/connectors/sync.ts', expr: 'key', why: P },
  { file: 'src/core/connectors/sync.ts', expr: 'key', why: P },
  { file: 'src/core/consent-cli.ts', expr: 'key', why: P },
  { file: 'src/core/content-repair/llm.ts', expr: 'key', why: P },
  { file: 'src/core/cycle/auto-think.ts', expr: 'key', why: P },
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
