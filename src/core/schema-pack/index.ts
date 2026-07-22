// v0.38 schema pack — public exports.
//
// Consumers (Phase B hardcoded-site refactors, T6-T8) import from
// this barrel only. Internal cross-module wiring goes via direct
// file paths to keep the dependency graph legible.

export {
  SCHEMA_PACK_API_VERSION,
  PACK_PRIMITIVES,
  type PackPrimitive,
  type SchemaPackManifest,
  type PackPageType,
  type PackLinkType,
  type ExtractableSpec,
  SchemaPackManifestSchema,
  SchemaPackManifestError,
  parseSchemaPackManifest,
  computeManifestSha8,
  packIdentity,
  // v0.41 T3 — calibration domain registry
  AGGREGATOR_KINDS,
  type AggregatorKind,
  type CalibrationDomain,
} from './manifest-v1.ts';

export {
  getPrimitiveDefaults,
  type PrimitiveDefaults,
} from './primitives.ts';

export {
  loadPackFromFile,
  loadPackFromString,
  parseYamlMini,
  SchemaPackLoaderError,
} from './loader.ts';

export {
  ALIAS_CLOSURE_MAX_DEPTH,
  AliasCycleError,
  AliasDepthExceededError,
  type AliasGraph,
  buildAliasGraph,
  expandClosure,
  computeAliasClosureHash,
} from './closure.ts';

export {
  type SourceClosureBinding,
  buildPerSourceBindings,
  buildSourceClosureCte,
} from './per-source.ts';

export {
  type CandidateAuditRecord,
  type LogCandidateOpts,
  isAuditVerbose,
  computeIsoWeekName,
  computeCandidateAuditPath,
  logCandidate,
  readRecentCandidates,
} from './candidate-audit.ts';

export {
  LINK_EXTRACTION_TOTAL_BUDGET_MS,
  PER_REGEX_TIMEOUT_MS,
  RegexTimeoutError,
  PageBudgetExceededError,
  PageRegexBudget,
  runRegexBounded,
} from './redos-guard.ts';

export {
  EXTENDS_DEPTH_WARN,
  EXTENDS_DEPTH_HARD_CAP,
  STAT_TTL_MS_DEFAULT,
  ExtendsChainTooDeepError,
  UnknownPackError,
  type ResolvedPack,
  type ResolutionInput,
  type ResolutionResult,
  resolveActivePackName,
  resolvePack,
  tryCachedPack,
  invalidatePackCache,
  _resetPackCacheForTests,
  _cacheSizeForTests,
  _cacheNamesForTests,
} from './registry.ts';

export {
  loadActivePack,
  resolveActivePackNameOnly,
  __setPackLocatorForTests,
  _resetPackLocatorForTests,
  type LoadActivePackInput,
  type PackLocator,
} from './load-active.ts';

export {
  SchemaPackTrustGateError,
  validateSchemaPackTrustGate,
  loadActivePackForOp,
} from './op-trust-gate.ts';

export {
  inferLinkTypeFromPack,
  frontmatterLinkTypeFromPack,
} from './link-inference.ts';

export {
  expertTypesFromPack,
  expertTypesFromPackOrThrow,
} from './expert-types.ts';

export {
  extractableTypesFromPack,
  extractableSpecsFromPack,
  getExtractableSpec,
  isExtractableType,
  refuseVerifierPathInV042,
} from './extractable.ts';

export {
  enrichableTypesFromPack,
  rubricNameForType,
} from './enrichable.ts';

// v0.40.6.0 Schema Cathedral v3 surface:
export { loadActivePackBestEffort } from './best-effort.ts';

export {
  type MutationOp,
  type MutationActor,
  type MutationOutcome,
  type MutationAuditRecord,
  type LogMutationOpts,
  type LogMutationFailureOpts,
  type MutationSummary,
  computeMutateAuditPath,
  logMutationSuccess,
  logMutationFailure,
  readRecentMutations,
  summarizeMutations,
} from './mutate-audit.ts';

export {
  DEFAULT_LOCK_TTL_MS,
  REFRESH_INTERVAL_MS,
  type LockOutcome,
  type PackLockOpts,
  type LockFileRecord,
  PackLockBusyError,
  isLockStale,
  acquirePackLock,
  withPackLock,
} from './pack-lock.ts';

export {
  type PackFileFormat,
  type MutateResult,
  type MutateOpts,
  type AddTypeOpts,
  type UpdateTypeOpts,
  type AddLinkTypeOpts,
  SchemaPackMutationError,
  BUNDLED_PACK_NAMES,
  locateMutablePackFile,
  withMutation,
  addTypeToPack,
  removeTypeFromPack,
  updateTypeOnPack,
  addAliasToType,
  removeAliasFromType,
  addPrefixToType,
  removePrefixFromType,
  addLinkTypeToPack,
  removeLinkTypeFromPack,
  setExtractableOnType,
  setExpertRoutingOnType,
} from './mutate.ts';

export { invalidateQueryCache } from './query-cache-invalidator.ts';

export {
  type StatsOpts,
  type StatsResult,
  type PerSourceStats,
  type TypeStats,
  type DeadPrefixHint,
  runStatsCore,
} from './stats.ts';

export {
  type SyncOpts,
  type SyncResult,
  type PerPrefixResult,
  runSyncCore,
} from './sync.ts';

export {
  type LintIssue,
  type LintOpts,
  type LintRule,
  type LintReport,
  type LintSeverity,
  ALL_LINT_RULES,
  FILE_PLANE_LINT_RULES,
  runAllLintRules,
  runFilePlaneLintRules,
} from './lint-rules.ts';
