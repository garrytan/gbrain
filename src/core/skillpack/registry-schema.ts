/**
 * skillpack/registry-schema.ts — runtime validators for the
 * `garrytan/gbrain-skillpack-registry` catalog files.
 *
 * Two files at the registry repo root:
 *   - registry.json     — catalog of all listed skillpacks
 *   - endorsements.json — Garry-controlled tier overrides (codex G3
 *     separation: contributors PR catalog entries; only Garry edits
 *     endorsements)
 *
 * Pure validators — no I/O. Used by the registry-client (fetch path)
 * and by the publish-gate when validating PR submissions.
 */

export const REGISTRY_SCHEMA_VERSION = 'gbrain-registry-v1' as const;
export const ENDORSEMENTS_SCHEMA_VERSION = 'gbrain-endorsements-v1' as const;

export type RegistryTier = 'endorsed' | 'community' | 'experimental' | 'dead';

export interface RegistrySource {
  /** Source kind — git is the v1 primary path; tarball-only is v1.5+. */
  kind: 'git';
  /** https:// URL to clone (must match the SSRF allowlist in git-remote.ts). */
  url: string;
  /** Pinned commit SHA at PR-merge time. Required for endorsed/community. */
  pinned_commit: string;
}

export interface RegistryEntry {
  /** Pack name (must match skillpack.json `name`). Unique in the catalog. */
  name: string;
  /** One-line description for `gbrain skillpack search` output. */
  description: string;
  /** Author display name (display only; account binding is via author_handle). */
  author: string;
  /** Account handle on the source host (e.g. "garrytan" for github.com/garrytan). */
  author_handle: string;
  /** Homepage URL (canonical pack repo). */
  homepage: string;
  /** Source metadata. */
  source: RegistrySource;
  /** SHA-256 of the published tarball at validation time. Used by the
   *  durability path: if source repo disappears, the registry-hosted
   *  tarballs/<name>-<version>.tgz mirror matches this hash. */
  tarball_sha256: string;
  /** Minimum gbrain version the pack supports. */
  gbrain_min_version: string;
  /** Default tier — may be overridden by endorsements.json. Catalog PRs
   *  always land at `community`. Endorsement happens via the separate
   *  `gbrain skillpack endorse` command writing endorsements.json. */
  default_tier: Exclude<RegistryTier, 'endorsed'>;
  /** Searchable tags (lowercase kebab strings). */
  tags: string[];
  /** ISO 8601 timestamp of the most-recent successful publish-gate validation. */
  validated_at: string;
  /** Reference to the immutable validation log under registry/validation-runs/. */
  validation_run_id: string;
  /** Cached count of skills in this pack (informational; from skillpack.json). */
  skills_count: number;
  /** Cached list of skill slugs (informational). */
  skills: string[];
  /** Pack version when validated. */
  version: string;
}

export interface RegistryBundles {
  /** Named bundles — `gbrain skillpack scaffold starter-pack` walks the list. */
  [bundleName: string]: string[];
}

export interface RegistryCatalog {
  schema_version: typeof REGISTRY_SCHEMA_VERSION;
  /** Catalog last-updated timestamp (informational). */
  updated_at: string;
  skillpacks: RegistryEntry[];
  /** Optional named bundles. */
  bundles?: RegistryBundles;
}

export interface EndorsementRecord {
  /** Tier this pack should resolve to (overriding default_tier). */
  tier: RegistryTier;
  /** When the endorsement was set. */
  endorsed_at: string;
  /** Optional human note (e.g. "promoted after 30 days of clean use"). */
  note?: string;
}

export interface EndorsementsFile {
  schema_version: typeof ENDORSEMENTS_SCHEMA_VERSION;
  /** Map from pack name → endorsement record. Missing entries inherit default_tier. */
  endorsements: Record<string, EndorsementRecord>;
}

export type RegistrySchemaErrorCode =
  | 'malformed_json'
  | 'unknown_schema'
  | 'missing_field'
  | 'invalid_field';

export class RegistrySchemaError extends Error {
  constructor(
    message: string,
    public code: RegistrySchemaErrorCode,
    public detail?: { field?: string; entryName?: string },
  ) {
    super(message);
    this.name = 'RegistrySchemaError';
  }
}

const TIER_VALUES = new Set<RegistryTier>(['endorsed', 'community', 'experimental', 'dead']);
const DEFAULT_TIER_VALUES = new Set<RegistryTier>(['community', 'experimental', 'dead']);

/** Validate a parsed JSON value as a RegistryCatalog. Throws on every gap. */
export function validateRegistryCatalog(raw: unknown): RegistryCatalog {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RegistrySchemaError('registry.json top-level must be an object', 'malformed_json');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schema_version !== REGISTRY_SCHEMA_VERSION) {
    throw new RegistrySchemaError(
      `registry.json schema_version is ${JSON.stringify(obj.schema_version)}; expected ${REGISTRY_SCHEMA_VERSION}`,
      'unknown_schema',
    );
  }
  if (typeof obj.updated_at !== 'string') {
    throw new RegistrySchemaError(
      'registry.json.updated_at must be a string',
      'invalid_field',
      { field: 'updated_at' },
    );
  }
  if (!Array.isArray(obj.skillpacks)) {
    throw new RegistrySchemaError(
      'registry.json.skillpacks must be an array',
      'invalid_field',
      { field: 'skillpacks' },
    );
  }
  for (const entry of obj.skillpacks) {
    validateRegistryEntry(entry);
  }
  if (obj.bundles !== undefined) {
    if (typeof obj.bundles !== 'object' || obj.bundles === null || Array.isArray(obj.bundles)) {
      throw new RegistrySchemaError(
        'registry.json.bundles must be an object map',
        'invalid_field',
        { field: 'bundles' },
      );
    }
    for (const [bundleName, names] of Object.entries(obj.bundles)) {
      if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) {
        throw new RegistrySchemaError(
          `registry.json.bundles.${bundleName} must be an array of pack-name strings`,
          'invalid_field',
          { field: `bundles.${bundleName}` },
        );
      }
    }
  }
  return raw as RegistryCatalog;
}

/** Validate one entry inside the skillpacks array. */
export function validateRegistryEntry(raw: unknown): RegistryEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RegistrySchemaError('registry entry must be an object', 'malformed_json');
  }
  const e = raw as Record<string, unknown>;
  const required = [
    'name',
    'description',
    'author',
    'author_handle',
    'homepage',
    'source',
    'tarball_sha256',
    'gbrain_min_version',
    'default_tier',
    'tags',
    'validated_at',
    'validation_run_id',
    'skills_count',
    'skills',
    'version',
  ] as const;
  for (const field of required) {
    if (!(field in e)) {
      throw new RegistrySchemaError(
        `registry entry is missing required field: ${field}`,
        'missing_field',
        { field, entryName: typeof e.name === 'string' ? e.name : undefined },
      );
    }
  }

  if (typeof e.name !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(e.name)) {
    throw new RegistrySchemaError(
      `registry entry name must be lowercase kebab-case; got ${JSON.stringify(e.name)}`,
      'invalid_field',
      { field: 'name' },
    );
  }
  for (const f of ['description', 'author', 'author_handle', 'homepage', 'tarball_sha256', 'gbrain_min_version', 'validated_at', 'validation_run_id', 'version']) {
    if (typeof e[f] !== 'string' || (e[f] as string).length === 0) {
      throw new RegistrySchemaError(
        `registry entry ${e.name}.${f} must be a non-empty string`,
        'invalid_field',
        { field: f, entryName: e.name as string },
      );
    }
  }

  if (typeof e.skills_count !== 'number' || !Number.isFinite(e.skills_count) || e.skills_count < 0) {
    throw new RegistrySchemaError(
      `registry entry ${e.name}.skills_count must be a non-negative number`,
      'invalid_field',
      { field: 'skills_count', entryName: e.name as string },
    );
  }

  if (!DEFAULT_TIER_VALUES.has(e.default_tier as RegistryTier)) {
    throw new RegistrySchemaError(
      `registry entry ${e.name}.default_tier must be one of community / experimental / dead (endorsed comes from endorsements.json); got ${JSON.stringify(e.default_tier)}`,
      'invalid_field',
      { field: 'default_tier', entryName: e.name as string },
    );
  }

  if (!Array.isArray(e.tags) || !e.tags.every((t) => typeof t === 'string')) {
    throw new RegistrySchemaError(
      `registry entry ${e.name}.tags must be an array of strings`,
      'invalid_field',
      { field: 'tags', entryName: e.name as string },
    );
  }
  if (!Array.isArray(e.skills) || !e.skills.every((s) => typeof s === 'string')) {
    throw new RegistrySchemaError(
      `registry entry ${e.name}.skills must be an array of strings`,
      'invalid_field',
      { field: 'skills', entryName: e.name as string },
    );
  }

  // Source object.
  if (typeof e.source !== 'object' || e.source === null || Array.isArray(e.source)) {
    throw new RegistrySchemaError(
      `registry entry ${e.name}.source must be an object`,
      'invalid_field',
      { field: 'source', entryName: e.name as string },
    );
  }
  const s = e.source as Record<string, unknown>;
  if (s.kind !== 'git') {
    throw new RegistrySchemaError(
      `registry entry ${e.name}.source.kind must be "git" in v1; got ${JSON.stringify(s.kind)}`,
      'invalid_field',
      { field: 'source.kind', entryName: e.name as string },
    );
  }
  if (typeof s.url !== 'string' || !/^https?:\/\//.test(s.url)) {
    throw new RegistrySchemaError(
      `registry entry ${e.name}.source.url must be an http(s) URL`,
      'invalid_field',
      { field: 'source.url', entryName: e.name as string },
    );
  }
  if (typeof s.pinned_commit !== 'string' || !/^[a-f0-9]{7,40}$/.test(s.pinned_commit)) {
    throw new RegistrySchemaError(
      `registry entry ${e.name}.source.pinned_commit must be a 7-40 hex git SHA`,
      'invalid_field',
      { field: 'source.pinned_commit', entryName: e.name as string },
    );
  }

  return raw as RegistryEntry;
}

/** Validate a parsed JSON value as an EndorsementsFile. */
export function validateEndorsementsFile(raw: unknown): EndorsementsFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RegistrySchemaError(
      'endorsements.json top-level must be an object',
      'malformed_json',
    );
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schema_version !== ENDORSEMENTS_SCHEMA_VERSION) {
    throw new RegistrySchemaError(
      `endorsements.json schema_version is ${JSON.stringify(obj.schema_version)}; expected ${ENDORSEMENTS_SCHEMA_VERSION}`,
      'unknown_schema',
    );
  }
  if (
    typeof obj.endorsements !== 'object' ||
    obj.endorsements === null ||
    Array.isArray(obj.endorsements)
  ) {
    throw new RegistrySchemaError(
      'endorsements.json.endorsements must be an object map',
      'invalid_field',
      { field: 'endorsements' },
    );
  }
  for (const [name, record] of Object.entries(obj.endorsements)) {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      throw new RegistrySchemaError(
        `endorsements.${name} must be an object`,
        'invalid_field',
        { field: name },
      );
    }
    const r = record as Record<string, unknown>;
    if (!TIER_VALUES.has(r.tier as RegistryTier)) {
      throw new RegistrySchemaError(
        `endorsements.${name}.tier must be one of endorsed / community / experimental / dead`,
        'invalid_field',
        { field: `${name}.tier` },
      );
    }
    if (typeof r.endorsed_at !== 'string') {
      throw new RegistrySchemaError(
        `endorsements.${name}.endorsed_at must be a string`,
        'invalid_field',
        { field: `${name}.endorsed_at` },
      );
    }
  }
  return raw as EndorsementsFile;
}

/**
 * Project a registry entry through the endorsements overlay to produce the
 * effective tier shown to the user. If endorsements.json has a record for
 * this pack, it wins; otherwise default_tier from the catalog applies.
 */
export function effectiveTier(
  entry: RegistryEntry,
  endorsements: EndorsementsFile | null,
): RegistryTier {
  if (!endorsements) return entry.default_tier;
  const override = endorsements.endorsements[entry.name];
  if (override) return override.tier;
  return entry.default_tier;
}
