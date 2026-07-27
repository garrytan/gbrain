// v0.38 Schema Pack Manifest v1
//
// Pack file shape (YAML or JSON; loader.ts handles sniffing). The contract
// here is the SOURCE OF TRUTH for what a `.gbrain-schema` tarball can carry.
//
// Two orthogonal fields per type (E8 refinement):
//   - `primitive` drives DEFAULTS (link verbs, frontmatter rules, enrichment
//     rubric, expert-routing flag inheritance from the primitive's seed).
//   - `aliases` drives QUERY EXPANSION (closure graph). Directed
//     declarations; symmetric per declaration; transitive resolution capped
//     at depth 4. Primitive does NOT drive closure. This prevents
//     adversary-profile (entity primitive) from surfacing in `whoknows expert`
//     just because it shares a primitive with person.
//
// Pack identity (for cache keys, replay records, registry):
//   `<pack-name>@<version>+<manifest-sha8>` (E10).

import { z } from 'zod';

export const SCHEMA_PACK_API_VERSION = 'gbrain-schema-pack-v1' as const;

/**
 * Five composable primitives. Closed enum — packs cannot add primitives,
 * only types that extend one. Compile-time exhaustiveness via
 * `assertNever()` is preserved over THIS enum (where it's actually
 * load-bearing) instead of over the open PageType.
 */
export const PACK_PRIMITIVES = ['entity', 'media', 'temporal', 'annotation', 'concept'] as const;
export type PackPrimitive = typeof PACK_PRIMITIVES[number];

const PackPrimitiveEnum = z.enum(PACK_PRIMITIVES);

const LinkInferenceSchema = z.object({
  regex: z.string().optional(),
  page_type: z.string().optional(),
  target_type: z.string().optional(),
}).strict();

const LinkTypeSchema = z.object({
  name: z.string().min(1),
  inverse: z.string().optional(),
  inference: LinkInferenceSchema.optional(),
}).strict();

/**
 * v0.41.23 — ExtractableSpec widening. `extractable` is now `boolean | struct`.
 *
 * v0.38 shape (`extractable: true`) stays valid forever; resolves to a
 * minimal default spec with empty fields. Pack authors opt into the struct
 * shape when they want pack-supplied prompts / fixtures / eval dimensions
 * for an LLM-backed extractor running over their page type.
 *
 * Forward-compat: `verifier_path` is RESERVED in v0.41.23. The parser accepts
 * the field (validated as relative path within pack root by future logic)
 * but the runtime REFUSES to load pack-shipped verifier code in v0.41.23 —
 * a follow-up release trust review is the gate. Pack authors who write the
 * path early get a clear runtime refuse message; they're not blocked at
 * parse time.
 *
 * See plan D-EXTRACT-17/19/21/37/42/47 for the load-bearing decisions.
 */
const ExtractableSpecSchema = z.object({
  /** Pack-supplied LLM prompt template. Plain text; sent to gateway.chat()
   * with NO conversation context per the v0.41.23 threat model. */
  prompt_template: z.string().optional(),
  /** Relative path within pack root to a JSONL fixture corpus. Validated
   * against path traversal at parse + load time. */
  fixture_corpus: z.string().optional(),
  /** Per-kind eval dimensions for the cross-modal eval gate. Open string
   * array; specific values consumed by `gbrain extract benchmark`. */
  eval_dimensions: z.array(z.string()).default([]),
  /** Optional recall floor for `gbrain extract benchmark` CI gate.
   * Defaults to 0.8 at consume site when omitted. */
  benchmark_min_recall: z.number().min(0).max(1).optional(),
  /** RESERVED for a follow-up release: relative path to pack-shipped verifier
   * code. Validated as relative + within-pack at parse; REFUSES at runtime
   * in v0.41.23 with paste-ready hint. */
  verifier_path: z.string().optional(),
}).strict();

export type ExtractableSpec = z.infer<typeof ExtractableSpecSchema>;

/**
 * v0.41.22 (T3, plan D5): per-page-type subtype-detection rule. The rule fires
 * when (a) frontmatter has a matching key+value, OR (b) the source path
 * matches the regex. ReDoS-guarded compile happens at pack-load (registry).
 */
const SubtypeMatchSchema = z.object({
  name: z.string().min(1),
  when: z.object({
    path_pattern: z.string().optional(),
    frontmatter_field: z.string().optional(),
    frontmatter_value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  }).strict(),
}).strict();

export type PackSubtypeMatch = z.infer<typeof SubtypeMatchSchema>;

const PageTypeSchema = z.object({
  name: z.string().min(1),
  primitive: PackPrimitiveEnum,
  /**
   * Path-prefix patterns inferType consults to map a markdown path to this
   * type. First match wins; order in the pack manifest determines priority.
   */
  path_prefixes: z.array(z.string()).default([]),
  /**
   * E8: explicit alias declarations drive query closure. `researcher`
   * declaring `aliases: [person]` means queries for `researcher` ALSO
   * surface person rows (symmetric per declaration). Empty array = type
   * is isolated in query expansion (adversary-profile, hater-dossier, etc.).
   * Transitive cap = 4 enforced at pack-load.
   */
  aliases: z.array(z.string()).default([]),
  /**
   * Whether the page-type is eligible for facts extraction.
   *
   * - `boolean` (v0.38 shape): true = extractable with default LLM handler;
   *   false = not extractable. Gates `src/core/facts/eligibility.ts:49`.
   * - `ExtractableSpec` (v0.42 widening): pack-supplied prompt + fixtures
   *   + eval dimensions for the pack-author authoring loop. Implies true
   *   for eligibility purposes.
   *
   * Defaults to false. Back-compat: every pre-v0.42 pack manifest with
   * `extractable: true` continues to parse unchanged.
   */
  extractable: z.union([z.boolean(), ExtractableSpecSchema]).default(false),
  /**
   * Whether this type is an "expert" for find_experts / whoknows queries
   * (replaces hardcoded ['person','company'] at whoknows.ts:89 + the
   * find_experts SQL hardcodes).
   */
  expert_routing: z.boolean().default(false),
  /**
   * v0.42 (T3, plan D5): per-type subtype declarations. `media` declaring
   * subtypes: [{name: video, when: {path_pattern: "^videos/"}}] means
   * inferTypeAndSubtypeFromPack returns `{type: 'media', subtype: 'video'}`
   * for paths starting with `videos/`. Frontmatter-based detection
   * supported via `frontmatter_field`+`frontmatter_value`. Optional for
   * back-compat: pre-v0.42 pack manifests + test fixtures that don't
   * declare it stay valid. Consumers MUST handle undefined via `?? []`.
   */
  subtypes: z.array(SubtypeMatchSchema).optional(),
}).strict();

const FrontmatterLinkSchema = z.object({
  page_type: z.string(),
  fields: z.array(z.string()).min(1),
  link_type: z.string(),
}).strict();

const EnrichableSchema = z.object({
  type: z.string(),
  rubric: z.string().optional(),
}).strict();

const FilingRuleSchema = z.object({
  kind: z.string(),
  directory: z.string(),
  examples: z.array(z.string()).default([]),
  description: z.string().optional(),
}).strict();

/**
 * v0.41 T3 — closed registry of calibration aggregator algorithms.
 *
 * Codex outside-voice refinement of D6: domain NAMES stay open (any pack
 * can declare `pricing_judgment` or `hiring_quality` without a gbrain
 * release), but the AGGREGATOR — the actual SQL/code that computes a
 * scorecard for that domain — must be a closed enum. New aggregator
 * algorithms ship via gbrain release; new domain names ship via pack
 * manifest. This splits the "what" (open) from the "how" (closed),
 * preserving extensibility without SQL injection surface.
 *
 * v1 aggregators:
 *   - `scalar_brier`     — standard Brier score over resolved binary takes
 *                          (sum((p - outcome)^2) / n). Default for most
 *                          predictive domains.
 *   - `weighted_brier`   — Brier weighted by take.confidence. Use when
 *                          calibration cares more about high-conviction
 *                          predictions than low-stakes ones.
 *   - `count_based`      — simple accuracy ratio (correct / resolved).
 *                          Use when binary outcomes don't have natural
 *                          probability semantics (e.g. did/didn't happen).
 *   - `cluster_summary`  — descriptive rollup (tier counts, dominant
 *                          topics, time span) instead of Brier. Used by
 *                          the creator pack's concept_themes domain where
 *                          there is no "right answer" to score against.
 *
 * Expand this enum in v0.42+ as real lens-pack usage surfaces new
 * aggregation needs. Each addition is a versioned gbrain release.
 */
export const AGGREGATOR_KINDS = [
  'scalar_brier',
  'weighted_brier',
  'count_based',
  'cluster_summary',
] as const;
export type AggregatorKind = typeof AGGREGATOR_KINDS[number];

const AggregatorKindSchema = z.enum(AGGREGATOR_KINDS);

/**
 * v0.41 T3 — per-pack calibration domain declaration. The calibration_profile
 * cycle phase widens at v0.41 from a placeholder `{}` JSONB to an aggregator
 * pass over each active pack's declared domains. Each entry binds:
 *   - `name`         — open string label visible in scorecards
 *                      (`deal_success`, `architecture_calls`, etc.)
 *   - `aggregator`   — closed-enum algorithm to compute the scorecard
 *   - `page_types`   — page types whose takes feed this domain (the
 *                      propose_takes phase populates take_domain_assignments
 *                      at write time from this mapping)
 *
 * Loaded by the registry at pack-load; validated against AggregatorKindSchema
 * before any aggregator code runs. Unknown aggregator values fail the pack
 * load with a paste-ready `gbrain models doctor`-style hint.
 */
const CalibrationDomainSchema = z.object({
  name: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/, 'domain name must be lowercase snake_case'),
  aggregator: AggregatorKindSchema,
  page_types: z.array(z.string().min(1)).min(1),
}).strict();

export type CalibrationDomain = z.infer<typeof CalibrationDomainSchema>;

/**
 * v0.42 (T3, plan D9): allowed values for retype `subtype_field`. Strict
 * allowlist prevents third-party-pack injection of `title` / `slug` / `type`
 * via mapping_rules — a malicious pack could otherwise overwrite load-bearing
 * frontmatter keys on every retyped page. Pack-load validation rejects
 * mapping_rules whose `subtype_field` is outside this set.
 */
export const ALLOWED_SUBTYPE_FIELDS = [
  'subtype', 'legacy_type', 'origin', 'format', 'kind', 'period', 'domain',
] as const;
export type AllowedSubtypeField = typeof ALLOWED_SUBTYPE_FIELDS[number];

/**
 * v0.42 (T3, plan D11+D12): pack-upgrade mapping_rules — declarative
 * migrations that the `unify-types` Minion handler consumes. Discriminated
 * union over three primitives:
 *   - retype: change pages.type from from_type to to_type with optional
 *     subtype JSONB stamp + legacy_type frontmatter preservation. Special
 *     sentinel `from_type: '*unknown*'` is the catch-all (D12) that fires
 *     LAST and retypes any page whose type isn't declared in page_types
 *     AND isn't the target of any prior retype rule (substituting the
 *     original type as the subtype value via `subtype: '*original_type*'`).
 *   - page_to_link: convert edge-shaped pages (atom-partner-link, symlink)
 *     into real links table rows + soft-delete the source page.
 *   - page_to_alias: convert redirect-shaped pages (concept-redirect) into
 *     slug_aliases table rows + soft-delete the source page. NO inbound
 *     link rewrite (D15: alias-table IS the resolver).
 */
const RetypeMappingRuleSchema = z.object({
  kind: z.literal('retype'),
  from_type: z.string().min(1),
  to_type: z.string().min(1),
  subtype: z.string().optional(),
  subtype_field: z.enum(ALLOWED_SUBTYPE_FIELDS).default('subtype'),
  path_filter: z.string().optional(),
}).strict();

const ResolverSchema = z.union([
  z.literal('frontmatter'),
  z.literal('body_first_link'),
  z.literal('slug'),
  z.literal('body_excerpt'),
  z.object({ frontmatter_field: z.string().min(1) }).strict(),
]);

const PageToLinkMappingRuleSchema = z.object({
  kind: z.literal('page_to_link'),
  from_type: z.string().min(1),
  link_type: z.string().min(1),
  source_slug_from: ResolverSchema,
  target_slug_from: ResolverSchema,
  inverse: z.string().optional(),
  preserve_notes: z.boolean().optional(),
}).strict();

const PageToAliasMappingRuleSchema = z.object({
  kind: z.literal('page_to_alias'),
  from_type: z.string().min(1),
  canonical_from: ResolverSchema,
  alias_slug_from: ResolverSchema,
  notes_from: ResolverSchema.optional(),
}).strict();

const MappingRuleSchema = z.discriminatedUnion('kind', [
  RetypeMappingRuleSchema,
  PageToLinkMappingRuleSchema,
  PageToAliasMappingRuleSchema,
]);

export type PackMappingRule = z.infer<typeof MappingRuleSchema>;
export type PackRetypeMappingRule = z.infer<typeof RetypeMappingRuleSchema>;
export type PackPageToLinkMappingRule = z.infer<typeof PageToLinkMappingRuleSchema>;
export type PackPageToAliasMappingRule = z.infer<typeof PageToAliasMappingRuleSchema>;
export type PackResolverSpec = z.infer<typeof ResolverSchema>;

/**
 * v0.42 (T3, plan D7): pack-upgrade declaration. When a pack declares
 * `migration_from: {pack: gbrain-base, version: "1.x"}`, the
 * `checkPackUpgradeAvailable` onboard check fires for any brain whose
 * active pack matches the (pack, semver-range) tuple. Version supports
 * `M.x` / `M.m.x` shorthand or an exact `M.m.p` literal.
 */
const MigrationFromSchema = z.object({
  pack: z.string().min(1),
  version: z.string().min(1),
}).strict();

export type PackMigrationFrom = z.infer<typeof MigrationFromSchema>;

/**
 * SchemaPackManifest v1 — the parsed + validated pack file shape.
 * `extends` resolution + closure expansion are done by registry.ts, not at
 * parse time.
 */
export const SchemaPackManifestSchema = z.object({
  api_version: z.literal(SCHEMA_PACK_API_VERSION),
  name: z.string().min(1).regex(/^[a-z0-9._-]+$/, 'pack name must be lowercase slug-shape'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver M.m.p'),
  description: z.string().default(''),
  author: z.string().optional(),
  license: z.string().optional(),
  homepage: z.string().url().optional(),
  /** v0.38 — minimum gbrain version required to load this pack. */
  gbrain_min_version: z.string().regex(/^\d+\.\d+\.\d+(?:\.\d+)?$/).default('0.38.0'),
  /** Parent pack (one of: 'gbrain-base', another installed pack name, or null for full override). */
  extends: z.string().nullable().default('gbrain-base'),
  /** v0.38 — selective borrow of types/link_types from another pack. */
  borrow_from: z.array(z.object({
    pack: z.string(),
    types: z.array(z.string()).optional(),
    link_types: z.array(z.string()).optional(),
  }).strict()).default([]),
  page_types: z.array(PageTypeSchema).default([]),
  link_types: z.array(LinkTypeSchema).default([]),
  frontmatter_links: z.array(FrontmatterLinkSchema).default([]),
  takes_kinds: z.array(z.string()).default(['fact', 'take', 'bet', 'hunch']),
  enrichable_types: z.array(EnrichableSchema).default([]),
  filing_rules: z.array(FilingRuleSchema).default([]),
  /**
   * v0.41 T3/D4 — phase participation declaration. The runCycle orchestrator
   * consults active pack's `phases:` to decide which pack-flavored cycle
   * phases run (extract_atoms, synthesize_concepts, future pack phases).
   * Pre-existing 17 core phases (lint, sync, extract, extract_facts,
   * propose_takes, etc.) ALWAYS run regardless of this declaration —
   * `phases:` is additive, not subtractive. `borrow_from` does NOT borrow
   * phases; each pack declares its own participation explicitly.
   *
   * Phase names are validated as strings at parse time and against the
   * runtime CyclePhase union at pack-load by the registry (kept as string[]
   * here to avoid a circular import from src/core/cycle.ts).
   *
   * Optional rather than .default([]) so existing v0.38 manifest casts in
   * test fixtures don't need to be re-typed; consumers apply `?? []` at
   * the read site.
   */
  phases: z.array(z.string().min(1)).optional(),
  /**
   * v0.41 T3 — per-pack calibration domain declarations. The
   * calibration_profile cycle phase widens at v0.41 from `{}` placeholder
   * JSONB to a real aggregator pass over each declared domain. See
   * CalibrationDomainSchema for the per-entry shape.
   *
   * Optional for the same reason as `phases` — preserves cast-compatibility
   * with pre-v0.41 fixtures.
   */
  calibration_domains: z.array(CalibrationDomainSchema).optional(),
  /**
   * v0.42 (T3, plan D7): pack-upgrade source declaration. When set, the
   * `checkPackUpgradeAvailable` onboard check fires for any brain whose
   * active pack matches the (pack, semver-range) tuple.
   */
  migration_from: MigrationFromSchema.optional(),
  /**
   * v0.42 (T3, plan D11+D12): declarative migrations consumed by the
   * `unify-types` Minion handler. Discriminated union over retype /
   * page_to_link / page_to_alias. Pack-load validation (registry):
   *   - All retype `to_type` values must exist in `page_types[]` (D11/F2)
   *   - All page_to_link `link_type` values must exist in `link_types[]`
   *   - Catch-all `from_type: '*unknown*'` rule must appear LAST (D12)
   *   - Cycles between retype rules rejected (e.g. A→B + B→A)
   */
  mapping_rules: z.array(MappingRuleSchema).optional(),
}).strict();

export type SchemaPackManifest = z.infer<typeof SchemaPackManifestSchema>;
export type PackPageType = z.infer<typeof PageTypeSchema>;
export type PackLinkType = z.infer<typeof LinkTypeSchema>;

/**
 * Validation error envelope. Mirrors `StructuredAgentError` shape from
 * `src/core/errors.ts` (v0.19.0) so CLI + MCP surfaces render uniformly.
 */
export class SchemaPackManifestError extends Error {
  readonly code: 'INVALID_API_VERSION' | 'INVALID_SHAPE' | 'INVALID_VERSION';
  readonly path?: string;
  readonly zodIssues?: unknown;

  constructor(
    code: 'INVALID_API_VERSION' | 'INVALID_SHAPE' | 'INVALID_VERSION',
    message: string,
    opts?: { path?: string; zodIssues?: unknown },
  ) {
    super(message);
    this.name = 'SchemaPackManifestError';
    this.code = code;
    this.path = opts?.path;
    this.zodIssues = opts?.zodIssues;
  }
}

/** Parse + validate. Throws SchemaPackManifestError on shape/version issues. */
export function parseSchemaPackManifest(
  raw: unknown,
  opts?: { path?: string },
): SchemaPackManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SchemaPackManifestError(
      'INVALID_SHAPE',
      'manifest must be a JSON/YAML object at the top level',
      { path: opts?.path },
    );
  }
  const apiVersion = (raw as Record<string, unknown>).api_version;
  if (apiVersion !== SCHEMA_PACK_API_VERSION) {
    throw new SchemaPackManifestError(
      'INVALID_API_VERSION',
      `unsupported api_version: ${JSON.stringify(apiVersion)}; expected ${SCHEMA_PACK_API_VERSION}`,
      { path: opts?.path },
    );
  }
  const result = SchemaPackManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new SchemaPackManifestError(
      'INVALID_SHAPE',
      `manifest validation failed: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      { path: opts?.path, zodIssues: result.error.issues },
    );
  }
  return result.data;
}

/** Compute the manifest's content hash (first 8 hex chars of SHA-256). */
export async function computeManifestSha8(manifest: SchemaPackManifest): Promise<string> {
  // Canonical JSON: sorted keys for determinism (E10 + codex F6 hash-determinism).
  const canonical = canonicalJSONStringify(manifest);
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(hashBuffer))
    .slice(0, 4)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function canonicalJSONStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSONStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSONStringify(obj[k])).join(',') + '}';
}

/**
 * Pack identity — used as cache key, replay record, registry id.
 * Format: `<name>@<version>+<sha8>`. Per codex F7.
 */
export function packIdentity(manifest: SchemaPackManifest, sha8: string): string {
  return `${manifest.name}@${manifest.version}+${sha8}`;
}
