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
  SchemaPackManifestSchema,
  SchemaPackManifestError,
  parseSchemaPackManifest,
  computeManifestSha8,
  packIdentity,
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
  ExtendsChainTooDeepError,
  UnknownPackError,
  type ResolvedPack,
  type ResolutionInput,
  type ResolutionResult,
  resolveActivePackName,
  resolvePack,
  _resetPackCacheForTests,
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
  isExtractableType,
} from './extractable.ts';

export {
  enrichableTypesFromPack,
  rubricNameForType,
} from './enrichable.ts';

export {
  type AddTypeOpts,
  type RemoveTypeOpts,
  type MutateResult,
  type PackFileFormat,
  SchemaPackMutationError,
  addTypeToPack,
  removeTypeFromPack,
  locateMutablePackFile,
  readPackForMutation,
  writePackManifest,
} from './mutate.ts';

export {
  type StatsOpts,
  type StatsResult,
  type PerTypeCount,
  runStats,
} from './stats.ts';

export {
  type SyncOpts,
  type SyncResult,
  type SyncPerType,
  runSync,
} from './sync.ts';
