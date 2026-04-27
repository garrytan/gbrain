/**
 * Entity and relationship taxonomy for markdown link extraction, filesystem extract, path→PageType
 * inference, enrichment slugs, and health metrics.
 *
 * **`referenceDirs` ({@link EntityTypeDefinition})** — Declares which **top-level slug segments**
 * identify this kind of page in wiki links and markdown (`people/…`, `deal/…`). Multiple strings
 * on one row are aliases for the same logical type (e.g. singular vs plural folders), not a
 * statement about regex or matching order.
 *
 * **Combined list — {@link ENTITY_REFERENCE_DIRS}** — Every row’s `referenceDirs` flattened in
 * {@link ENTITY_TYPES} order (stable exports and contract tests). {@link isEntityReferenceDir}
 * uses set membership only.
 *
 * **Directory alternation — {@link DIR_PATTERN} via {@link buildEntityDirRegexFragment}** — The
 * extractor whitelist is built from that combined list. When token names **share prefixes**
 * (`project` vs `projects`), ambiguity is resolved **in this module** by sorting alternatives
 * longest-token-first before building `(?:…|…)`, not by reordering `ENTITY_TYPES` or entries inside
 * `referenceDirs`.
 *
 * **`inferPageTypeFromPath`** — Overlapping path substring patterns can classify the same path
 * differently depending on rule order. Prefer mutually exclusive fragments; curate
 * {@link SPECIAL_PAGE_TYPE_INFERENCE_RULES} vs entity-derived rules; add explicit precedence on
 * {@link PageTypeInferenceRule} if needed; or evolve the helper to compare longest match first.
 */
import type { PageType } from './types.ts';

export interface EntityCustomBehavior {
  /**
   * Whether `gbrain check-backlinks` ({@link import('../commands/backlinks.ts').extractEntityRefs}-style
   * filtering via {@link isBacklinkEntityDir}) treats outbound links into this row’s dirs as **backlink
   * gaps** when the target page does not link back (Iron Law targets). When **true**, this row’s
   * `referenceDirs` are merged into {@link BACKLINK_ENTITY_DIRS}. Same mechanical plumbing as other
   * dir lists; this flag only gates the **backlink checker**, not extraction or graph ingest.
   *
   * **Prefer `false` when:**
   *
   * - Reciprocal backlinks are not part of the workflow or would be noisy (many-to-one cites,
   *   glossaries, media, sources). *Examples in {@link ENTITY_TYPES}:*
   *   `meeting`, `concept`, `deal`, `media`, `source`, `project` typically stay **false** so those
   *   link types do not participate in missing-backlink reports.
   * - The directory is organizational (`tech`, `finance`, `personal`, `openclaw`) or a catch-all
   *   (`legacy-entity`): you still want links and extraction, but not enforced mutual linking.
   * - Enabling it would imply every mention of that kind requires a timeline/backlink row on the
   *   target (cost + false positives for types that are not “entity pages” in the people/company sense).
   *
   * **Set `true` only when** maintaining symmetric citations for that dir set is a product requirement
   * (today: `people` / `companies`). Keep independent of {@link healthMetrics} and {@link enrichment};
   * a type can be link-checked without being in `getHealth()` entity denominators or vice versa.
   */
  backlinks: boolean;
  /**
   * Whether this row’s `pageType` (required for **true**) is included in {@link HEALTH_ENTITY_PAGE_TYPES}
   * and {@link HealthEntityPageType}. Engines pass that list to {@link import('./engine.ts').BrainHealth}
   * / `getHealth()` so **entity-page** metrics use a bounded set: entity `pages` rows, link/timeline
   * coverage ratios, and “most connected” scoped to those types ({@link isHealthEntityPageType} for
   * predicates). Return shape is {@link import('./types.ts').BrainHealth}. Independent of {@link backlinks}
   * (graph coverage vs reciprocal-link policy).
   *
   * **Prefer `false` when:**
   *
   * - The PageType should not drive the **entity slice** of the health dashboard (`doctor`, brain score
   *   components that use entity denominators). *Examples in {@link ENTITY_TYPES}:*
   *   `meeting`, `concept`, `deal`, `media`, `source`, `project`, `yc`, `civic`, `tech`, … stay **false**
   *   so volumes of notes, meetings, or namespaces do not dilute or dominate entity coverage KPIs meant
   *   for core contact/company pages.
   * - You have no `pageType` on the row yet; health metrics require a stable DB `pages.type` value—do
   *   not toggle **true** without defining `pageType`.
   *
   * **Set `true` only when** this PageType should count as a **first-class entity target** for those
   * ratios (today: `person` / `company`). Must agree with a defined {@link EntityTypeDefinition.pageType};
   * changing this flag changes SQL denominators and doctor-facing numbers—treat as a behavioral contract.
   */
  healthMetrics: boolean;
  /**
   * Whether the **global** {@link import('./enrichment-service.ts').enrichEntity} pipeline may
   * create or update pages of this kind (stub body, mention-based tier, timeline backlink). The
   * service is built for a **closed** set of request kinds: {@link EnrichmentRequestType} and
   * {@link ENRICHMENT_SLUG_PREFIX_BY_REQUEST_TYPE}; only those rows should set this to **true**
   * and pair it with {@link EnrichmentEntityBehavior} (e.g. `requestType` on the row).
   *
   * **Prefer `false` when:**
   *
   * - Pages should come from deliberate authoring, ingest, or another skill (not “named in chat →
   *   create thin page”). *Examples in {@link ENTITY_TYPES}:*
   *   rows `meeting`, `concept`, `deal`, `media`, `source` usually stay **false** so meetings,
   *   write-ups, and sources are created where the workflow already owns quality and structure.
   * - Auto-stubs would pollute search and the graph (high volume, arbitrary titles, or types that
   *   are namespaces rather than “entities” in the people/company sense: *e.g.* `tech`, `finance`,
   *   `personal`, `openclaw`, `legacy-entity`).
   * - You have not yet extended `EnrichmentRequestType`, slug prefixes, and stub content for the
   *   new type; turning this on without wiring would let call sites compile while behavior stays
   *   undefined or wrong.
   *
   * **Set `true` only when** this type is a first-class enrichment target: same lifecycle as
   * `person` / `company` today (stub generator, tiering, optional external research in the enrich
   * skill). Must agree with the row’s optional `enrichment` property ({@link EnrichmentEntityBehavior})
   * and the taxonomy maps ({@link ENRICHMENT_SLUG_PREFIX_BY_REQUEST_TYPE}) above.
   */
  enrichment: boolean;
}

/**
 * Canonical slug prefixes for enrichment stub pages. **Single source** for enrichment request
 * kinds: {@link EnrichmentRequestType} is `keyof` this object (duplicate keys are invalid in JS/TS).
 */
export const ENRICHMENT_SLUG_PREFIX_BY_REQUEST_TYPE = {
  person: 'people',
  company: 'companies',
} as const;

/** Enrichment API / `slugifyEntity` discriminator; extends automatically when you add a map entry. */
export type EnrichmentRequestType = keyof typeof ENRICHMENT_SLUG_PREFIX_BY_REQUEST_TYPE;

export interface EnrichmentEntityBehavior {
  requestType: EnrichmentRequestType;
}

/**
 * Fillable form for adding a new entity-like type.
 *
 * Think through every boolean deliberately. A new type can be a markdown reference
 * target without becoming a health-metric entity, a backlink target, or an
 * enrichment-created page.
 *
 * **Custom behavior booleans vs optional `enrichment` object:**
 *
 * - **`customBehavior.backlinks`** — Gates {@link BACKLINK_ENTITY_DIRS} / {@link isBacklinkEntityDir}
 *   (check-backlinks Iron Law targets). See {@link EntityCustomBehavior.backlinks}.
 * - **`customBehavior.healthMetrics`** — Gates {@link HEALTH_ENTITY_PAGE_TYPES} / `getHealth()` entity
 *   denominators ({@link isHealthEntityPageType}). See {@link EntityCustomBehavior.healthMetrics}.
 * - **`customBehavior.enrichment`** — Gates {@link import('./enrichment-service.ts').enrichEntity}.
 *   The optional **`enrichment`** property on the row is **only** when this boolean is true and carries
 *   {@link EnrichmentEntityBehavior}. Keeping enrichment false is normal; see {@link EntityCustomBehavior.enrichment}.
 */
export interface EntityTypeDefinition {
  /** Stable internal key for humans and tests; not stored in DB. */
  key: string;
  /** Human singular name: "person", "company", "media item". */
  singular: string;
  /** Human plural name and the first naming decision for new entity types. */
  plural: string;
  /**
   * Top-level slug segments for this type in entity links (`people/foo`, …). Multiple entries
   * are folder aliases for the same kind. How all rows’ dirs feed {@link ENTITY_REFERENCE_DIRS}
   * and {@link DIR_PATTERN} is described in the **module overview** (file top).
   */
  referenceDirs: readonly string[];
  /** PageType inferred from path patterns, when this maps to a typed page. */
  pageType?: PageType;
  /** Path fragments that infer pageType. Add both singular and plural paths when both exist. */
  pathInferencePatterns: readonly string[];
  /** Yes/no checklist for the places this type may have custom behavior. */
  customBehavior: EntityCustomBehavior;
  /**
   * Required when {@link EntityCustomBehavior.enrichment} is true: wires this row’s PageType into
   * {@link EnrichmentRequestType}. Omit when enrichment is false (most rows): those types are still
   * linkable and extractable; they are simply out of scope for automatic stub creation via
   * {@link import('./enrichment-service.ts').enrichEntity}.
   */
  enrichment?: EnrichmentEntityBehavior;
}

/** Canonical relationship labels produced by deterministic extractors / heuristics. */
export const RELATIONSHIP = Object.freeze({
  MENTIONS: 'mentions',
  WORKS_AT: 'works_at',
  INVESTED_IN: 'invested_in',
  FOUNDED: 'founded',
  ADVISES: 'advises',
  ATTENDED: 'attended',
  SOURCE: 'source',
  RELATED_TO: 'related_to',
  DISCUSSED_IN: 'discussed_in',
  YC_PARTNER: 'yc_partner',
  LED_ROUND: 'led_round',
  INVOLVED_IN: 'involved_in',
  DEAL_FOR: 'deal_for',
} as const);

/**
 * Values the **code** can assign from heuristics: `inferLinkType`, frontmatter mapping, fs rules.
 * Tight union so new relationship labels are added in one place (`RELATIONSHIP`) and typecheck
 * at call sites that *produce* graph edges from markdown.
 */
export type InferredLinkType = (typeof RELATIONSHIP)[keyof typeof RELATIONSHIP];

/**
 * What the **database and public API** store and return for `link_type` / graph edge type: plain
 * `TEXT` with no DB-level enum. User-provided and agent-injected values are not limited to
 * `InferredLinkType`. Use this name at persistence and read boundaries; use `InferredLinkType` only
 * on paths that originate from deterministic extractors.
 */
export type StoredLinkType = string;

/**
 * Converts an inferred label into the persisted form (`links.link_type`).
 * Identity today; keeps a single choke point if inference labels are ever renamed or normalized.
 */
export function asStoredLinkType(type: InferredLinkType): StoredLinkType {
  return type;
}

export interface FrontmatterLinkFieldMapping {
  fields: string[];
  pageType?: string;
  type: InferredLinkType;
  direction: 'outgoing' | 'incoming';
  dirHint: string | string[];
}

export interface PageTypeInferenceRule {
  patterns: string[];
  type: PageType;
}

/**
 * Ordered registry of entity-like types (fillable form). Directory naming and path-inference
 * hazards are summarized in the **module overview** (file top).
 */
export const ENTITY_TYPES = [
  {
    key: 'person',
    singular: 'person',
    plural: 'people',
    referenceDirs: ['people'],
    pageType: 'person',
    pathInferencePatterns: ['/people/', '/person/'],
    customBehavior: { backlinks: true, healthMetrics: true, enrichment: true },
    enrichment: { requestType: 'person' },
  },
  {
    key: 'company',
    singular: 'company',
    plural: 'companies',
    referenceDirs: ['companies'],
    pageType: 'company',
    pathInferencePatterns: ['/companies/', '/company/'],
    customBehavior: { backlinks: true, healthMetrics: true, enrichment: true },
    enrichment: { requestType: 'company' },
  },
  {
    key: 'meeting',
    singular: 'meeting',
    plural: 'meetings',
    referenceDirs: ['meetings'],
    pageType: 'meeting',
    pathInferencePatterns: ['/meetings/', '/meeting/'],
    customBehavior: { backlinks: false, healthMetrics: false, enrichment: false },
  },
  {
    key: 'concept',
    singular: 'concept',
    plural: 'concepts',
    referenceDirs: ['concepts'],
    pageType: 'concept',
    pathInferencePatterns: ['/wiki/concepts/', '/wiki/concept/'],
    customBehavior: { backlinks: false, healthMetrics: false, enrichment: false },
  },
  {
    key: 'deal',
    singular: 'deal',
    plural: 'deals',
    referenceDirs: ['deal'],
    pageType: 'deal',
    pathInferencePatterns: ['/deals/', '/deal/'],
    customBehavior: { backlinks: false, healthMetrics: false, enrichment: false },
  },
  {
    key: 'civic',
    singular: 'civic',
    plural: 'civic',
    referenceDirs: ['civic'],
    pageType: 'civic',
    pathInferencePatterns: ['/civic/'],
    customBehavior: { backlinks: false, healthMetrics: false, enrichment: false },
  },
  {
    key: 'project',
    singular: 'project',
    plural: 'projects',
    referenceDirs: ['project', 'projects'],
    pageType: 'project',
    pathInferencePatterns: ['/projects/', '/project/'],
    customBehavior: { backlinks: false, healthMetrics: false, enrichment: false },
  },
  {
    key: 'source',
    singular: 'source',
    plural: 'sources',
    referenceDirs: ['source'],
    pageType: 'source',
    pathInferencePatterns: ['/sources/', '/source/'],
    customBehavior: { backlinks: false, healthMetrics: false, enrichment: false },
  },
  {
    key: 'media',
    singular: 'media item',
    plural: 'media',
    referenceDirs: ['media'],
    pageType: 'media',
    pathInferencePatterns: ['/media/'],
    customBehavior: { backlinks: false, healthMetrics: false, enrichment: false },
  },
  {
    key: 'yc',
    singular: 'yc page',
    plural: 'yc pages',
    referenceDirs: ['yc'],
    pageType: 'yc',
    pathInferencePatterns: ['/yc/'],
    customBehavior: { backlinks: false, healthMetrics: false, enrichment: false },
  },
  {
    key: 'tech',
    singular: 'tech page',
    plural: 'tech pages',
    referenceDirs: ['tech'],
    pathInferencePatterns: [],
    customBehavior: { backlinks: false, healthMetrics: false, enrichment: false },
  },
  {
    key: 'finance',
    singular: 'finance page',
    plural: 'finance pages',
    referenceDirs: ['finance'],
    pathInferencePatterns: [],
    customBehavior: { backlinks: false, healthMetrics: false, enrichment: false },
  },
  {
    key: 'personal',
    singular: 'personal page',
    plural: 'personal pages',
    referenceDirs: ['personal'],
    pathInferencePatterns: [],
    customBehavior: { backlinks: false, healthMetrics: false, enrichment: false },
  },
  {
    key: 'openclaw',
    singular: 'openclaw page',
    plural: 'openclaw pages',
    referenceDirs: ['openclaw'],
    pathInferencePatterns: [],
    customBehavior: { backlinks: false, healthMetrics: false, enrichment: false },
  },
  {
    key: 'legacy-entity',
    singular: 'legacy entity',
    plural: 'legacy entities',
    referenceDirs: ['entities'],
    pathInferencePatterns: [],
    customBehavior: { backlinks: false, healthMetrics: false, enrichment: false },
  },
] as const satisfies readonly EntityTypeDefinition[];

/** Flatten of each row’s {@link EntityTypeDefinition.referenceDirs} in {@link ENTITY_TYPES} order. */
export const ENTITY_REFERENCE_DIRS = ENTITY_TYPES.flatMap(e => e.referenceDirs);

/**
 * Directory names whose inbound links `gbrain check-backlinks` may treat as backlink gaps.
 * Derived from each row’s {@link EntityCustomBehavior.backlinks}: when true, that row’s
 * `referenceDirs` are concatenated (same mechanical pattern as {@link ENTITY_REFERENCE_DIRS},
 * different {@link EntityCustomBehavior} gate).
 */
export const BACKLINK_ENTITY_DIRS = ENTITY_TYPES
  .filter(e => e.customBehavior.backlinks)
  .flatMap(e => e.referenceDirs);

/**
 * PageType values included in `getHealth()` entity-coverage denominators.
 * Derived at the type level from `ENTITY_TYPES` rows whose {@link EntityCustomBehavior.healthMetrics}
 * is true and which define a `pageType` — the type and the runtime array below stay aligned with
 * that checklist field (not with `backlinks`).
 */
export type HealthEntityPageType = Extract<
  (typeof ENTITY_TYPES)[number],
  { readonly customBehavior: { readonly healthMetrics: true }; readonly pageType: PageType }
>['pageType'];

/** Runtime filter for {@link HEALTH_ENTITY_PAGE_TYPES}; same {@link EntityCustomBehavior.healthMetrics} gate as {@link HealthEntityPageType}. */
type EntityTypeWithHealthMetrics = Extract<
  (typeof ENTITY_TYPES)[number],
  { readonly customBehavior: { readonly healthMetrics: true }; readonly pageType: PageType }
>;

/** Same members as {@link HealthEntityPageType}; built from {@link EntityCustomBehavior.healthMetrics} + `pageType`. */
export const HEALTH_ENTITY_PAGE_TYPES = ENTITY_TYPES.filter(
  (e): e is EntityTypeWithHealthMetrics =>
    e.customBehavior.healthMetrics && 'pageType' in e && e.pageType !== undefined,
).map(e => e.pageType);


export function enrichmentSlugPrefixForEntityType(type: EnrichmentRequestType): string {
  return ENRICHMENT_SLUG_PREFIX_BY_REQUEST_TYPE[type];
}

export const FS_LINK_TYPE_RULES = [
  { fromDir: 'people', toDir: 'companies', type: RELATIONSHIP.FOUNDED, whenFrontmatterArrayField: 'founded' },
  { fromDir: 'people', toDir: 'companies', type: RELATIONSHIP.WORKS_AT },
  { fromDir: 'people', toDir: 'deals', type: RELATIONSHIP.INVOLVED_IN },
  { fromDir: 'deals', toDir: 'companies', type: RELATIONSHIP.DEAL_FOR },
  { fromDir: 'meetings', toDir: 'people', type: RELATIONSHIP.ATTENDED },
] as const;

export const FRONTMATTER_RELATIONSHIP_MAP: readonly FrontmatterLinkFieldMapping[] = [
  // Person pages → companies
  { fields: ['company', 'companies'], pageType: 'person', type: RELATIONSHIP.WORKS_AT, direction: 'outgoing', dirHint: 'companies' },
  { fields: ['founded'], pageType: 'person', type: RELATIONSHIP.FOUNDED, direction: 'outgoing', dirHint: 'companies' },
  // Company pages (incoming relationships — subject of the verb lives elsewhere)
  { fields: ['key_people'], pageType: 'company', type: RELATIONSHIP.WORKS_AT, direction: 'incoming', dirHint: 'people' },
  { fields: ['partner'], pageType: 'company', type: RELATIONSHIP.YC_PARTNER, direction: 'incoming', dirHint: 'people' },
  { fields: ['investors'], pageType: 'company', type: RELATIONSHIP.INVESTED_IN, direction: 'incoming', dirHint: ['companies', 'funds', 'people'] },
  // Deal pages (all incoming — deals are the object)
  { fields: ['investors'], pageType: 'deal', type: RELATIONSHIP.INVESTED_IN, direction: 'incoming', dirHint: ['companies', 'funds', 'people'] },
  { fields: ['lead'], pageType: 'deal', type: RELATIONSHIP.LED_ROUND, direction: 'incoming', dirHint: ['companies', 'funds', 'people'] },
  // Meeting pages
  { fields: ['attendees'], pageType: 'meeting', type: RELATIONSHIP.ATTENDED, direction: 'incoming', dirHint: 'people' },
  // Any page type
  { fields: ['sources'], type: RELATIONSHIP.DISCUSSED_IN, direction: 'incoming', dirHint: ['source', 'media'] },
  { fields: ['source'], type: RELATIONSHIP.SOURCE, direction: 'outgoing', dirHint: '' },
  { fields: ['related', 'see_also'], type: RELATIONSHIP.RELATED_TO, direction: 'outgoing', dirHint: '' },
];

const SPECIAL_PAGE_TYPE_INFERENCE_RULES: readonly PageTypeInferenceRule[] = [
  { patterns: ['/writing/'], type: 'writing' },
  { patterns: ['/wiki/analysis/'], type: 'analysis' },
  { patterns: ['/wiki/guides/', '/wiki/guide/'], type: 'guide' },
  { patterns: ['/wiki/hardware/'], type: 'hardware' },
  { patterns: ['/wiki/architecture/'], type: 'architecture' },
  { patterns: ['/emails/', '/email/'], type: 'email' },
  { patterns: ['/slack/'], type: 'slack' },
  { patterns: ['/cal/', '/calendar/'], type: 'calendar-event' },
  { patterns: ['/notes/', '/note/'], type: 'note' },
];

// Mirrors src/core/markdown.ts inferType() precedence. Special subtypes stay first
// because they are stronger signals than broader entity/content directories.
export const PAGE_TYPE_INFERENCE_RULES: readonly PageTypeInferenceRule[] = [
  ...SPECIAL_PAGE_TYPE_INFERENCE_RULES.slice(0, 5),
  ...ENTITY_TYPES
    .filter(
      (e): e is (typeof ENTITY_TYPES)[number] & { readonly pageType: PageType } =>
        'pageType' in e && e.pageType !== undefined && e.pathInferencePatterns.length > 0,
    )
    .map(e => ({ patterns: [...e.pathInferencePatterns], type: e.pageType })),
  ...SPECIAL_PAGE_TYPE_INFERENCE_RULES.slice(5),
];

/** Builds `(?:…|…)` for {@link DIR_PATTERN}; longest-token-first policy — module overview (file top). */
export function buildEntityDirRegexFragment(dirs: readonly string[] = ENTITY_REFERENCE_DIRS): string {
  const ordered = [...dirs].sort((a, b) => b.length - a.length || a.localeCompare(b));
  return `(?:${ordered.join('|')})`;
}

/** Directory alternation for link extractors ({@link buildEntityDirRegexFragment}). */
export const DIR_PATTERN = buildEntityDirRegexFragment();

const ENTITY_DIR_SET = new Set<string>(ENTITY_REFERENCE_DIRS as readonly string[]);
const BACKLINK_DIR_SET = new Set<string>(BACKLINK_ENTITY_DIRS as readonly string[]);
const HEALTH_TYPE_SET = new Set<string>(HEALTH_ENTITY_PAGE_TYPES as readonly string[]);

export function isEntityReferenceDir(dir: string): boolean {
  return ENTITY_DIR_SET.has(dir);
}

export function isBacklinkEntityDir(dir: string): boolean {
  return BACKLINK_DIR_SET.has(dir);
}

export function isHealthEntityPageType(type: string): type is HealthEntityPageType {
  return HEALTH_TYPE_SET.has(type);
}

export function inferPageTypeFromPath(filePath?: string): PageType {
  if (!filePath) return 'concept';
  const lower = ('/' + filePath).toLowerCase();
  for (const rule of PAGE_TYPE_INFERENCE_RULES) {
    for (const p of rule.patterns) {
      if (lower.includes(p)) return rule.type;
    }
  }
  return 'concept';
}

export function inferFsLinkTypeByTopDirs(
  fromTopDir: string,
  toTopDir: string,
  frontmatter?: Record<string, unknown>,
): InferredLinkType {
  const from = fromTopDir.split('/')[0];
  const to = toTopDir.split('/')[0];
  for (const rule of FS_LINK_TYPE_RULES) {
    if (from !== rule.fromDir || to !== rule.toDir) continue;
    if ('whenFrontmatterArrayField' in rule && !Array.isArray(frontmatter?.[rule.whenFrontmatterArrayField])) continue;
    return rule.type;
  }
  return RELATIONSHIP.MENTIONS;
}

