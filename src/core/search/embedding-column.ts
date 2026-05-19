/**
 * Dynamic embedding column resolver (v0.36 — D2+D3+D11+D12).
 *
 * Single source of truth for "which content_chunks column gets searched, and
 * what provider produced its vectors." The hybrid/op boundary calls
 * `resolveEmbeddingColumn()` once and passes the resulting descriptor INTO
 * the engine; engines never read config or call the resolver themselves
 * (D11 — engine stays a pure SQL composer).
 *
 *                      ┌─────────────────────────────────────────────┐
 *                      │  Config registry (file + DB plane merged)   │
 *                      │   embedding_columns: { name → entry }       │
 *                      │   search_embedding_column: string           │
 *                      └────────────────────┬────────────────────────┘
 *                                           │
 *                                           ▼
 *                      ┌─────────────────────────────────────────────┐
 *                      │  getEmbeddingColumnRegistry(cfg)            │
 *                      │   Merge: BUILTIN_KEYS + user config         │
 *                      │   Validate at load time (D12):              │
 *                      │     key:  /^[a-z_][a-z0-9_]*$/              │
 *                      │     type: 'vector' | 'halfvec'              │
 *                      │     dims: 1..8192                           │
 *                      │     provider: parseable 'provider:model'    │
 *                      └────────────────────┬────────────────────────┘
 *                                           │
 *                  ┌────────────────────────┼────────────────────────┐
 *                  ▼                        ▼                        ▼
 *      ┌──────────────────────┐ ┌──────────────────────┐ ┌─────────────────────┐
 *      │ resolveEmbeddingCol  │ │ getEmbeddingColumnRe │ │ buildVectorCastFrag │
 *      │ (opts, cfg)          │ │ gistry(cfg)          │ │ ment(resolved)      │
 *      │                      │ │                      │ │                     │
 *      │ Chain:               │ │ Returns full reg     │ │ Returns:            │
 *      │  opts.embeddingColumn│ │ for doctor + config  │ │  { col, castSql }   │
 *      │  → cfg.search_emb_   │ │ validation.          │ │                     │
 *      │     column           │ │                      │ │ col: quoted ident   │
 *      │  → 'embedding'       │ │                      │ │  "<name>" (D12)     │
 *      │                      │ │                      │ │ castSql:            │
 *      │ Returns Resolved-    │ │                      │ │  '$1::vector' OR    │
 *      │ Column descriptor.   │ │                      │ │  '$1::halfvec(N)'   │
 *      └──────────┬───────────┘ └──────────────────────┘ └─────────────────────┘
 *                 │
 *                 ▼  (descriptor passed to engines + cosineReScore)
 *      ┌──────────────────────────────────────────────────────────────────┐
 *      │ engines: searchVector + getEmbeddingsByChunkIds                  │
 *      │   SQL: SELECT ... FROM content_chunks cc                         │
 *      │          WHERE cc.${quoteIdentifier(name)} IS NOT NULL           │
 *      │          ORDER BY cc.${quoteIdentifier(name)} <=> $1::${cast}    │
 *      └──────────────────────────────────────────────────────────────────┘
 *
 * Trust boundary: registry KEYS come from user config (DB plane + file
 * plane). Any path with config-write access can in principle declare a key.
 * Defense in depth:
 *   1. Strict regex on every key at load time — loud throw on invalid.
 *   2. Identifier-quoting at SQL-build time — even if regex misses,
 *      pgvector identifier quoting prevents string-break injection.
 *   3. Field validation at load (type/dims/provider) — bad config refuses
 *      to load instead of silently ignoring entries.
 *
 * Future write-path PR (`gbrain embed --column X --model Y`, deferred per
 * D1 out-of-scope list) MUST also consume this resolver — never compute a
 * column→provider mapping by hand. This is the canonical seam.
 */

import type {
  EmbeddingColumnConfig,
  ResolvedColumn,
  SearchOpts,
} from '../types.ts';
import type { GBrainConfig } from '../config.ts';

// ---- Constants ---------------------------------------------------------

/** Strict identifier regex for registry keys. Defense layer 1 of D12. */
export const COLUMN_NAME_REGEX = /^[a-z_][a-z0-9_]*$/;

/** Allowed pgvector types for this registry. Halfvec lands at v0.4.3+. */
export const ALLOWED_COLUMN_TYPES = new Set<EmbeddingColumnConfig['type']>([
  'vector',
  'halfvec',
]);

/** Upper bound on declared dimensions. pgvector hard cap is 16K but
 *  practical embedding models top out around 4096; 8192 is plenty of
 *  headroom and rejects obvious junk like negative or astronomical
 *  values. */
export const MAX_DIMENSIONS = 8192;

/**
 * Default name used when neither caller nor config sets a column.
 * Resolution chain: opts → cfg.search_embedding_column → DEFAULT.
 */
export const DEFAULT_COLUMN_NAME = 'embedding';

/** Names that always exist regardless of user config. Both derive their
 *  provider from existing config keys (embedding_model and
 *  embedding_multimodal_model) so users who don't declare anything still
 *  get correct routing. */
const BUILTIN_KEYS = ['embedding', 'embedding_image'] as const;
type BuiltinKey = (typeof BUILTIN_KEYS)[number];

// ---- Errors -----------------------------------------------------------

/**
 * Thrown when a column name isn't in the merged registry. Carries a
 * paste-ready hint listing valid columns so the user (or agent) sees
 * exactly what to type next.
 */
export class EmbeddingColumnNotRegisteredError extends Error {
  readonly code = 'embedding_column_not_registered';
  readonly columnName: string;
  readonly validColumns: string[];

  constructor(columnName: string, validColumns: string[]) {
    const valid = validColumns.length > 0 ? validColumns.join(', ') : '(none)';
    super(
      `Embedding column "${columnName}" is not registered. ` +
        `Declared columns: ${valid}. ` +
        `Add it via: gbrain config set embedding_columns '<JSON>'`,
    );
    this.name = 'EmbeddingColumnNotRegisteredError';
    this.columnName = columnName;
    this.validColumns = validColumns;
  }
}

/**
 * Thrown when a registry entry fails load-time validation. The .field
 * pinpoints which sub-shape was wrong so doctor + config-set surfaces
 * can render targeted hints.
 */
export class EmbeddingColumnConfigError extends Error {
  readonly code = 'embedding_column_config_invalid';
  readonly columnKey: string;
  readonly field: 'key' | 'type' | 'dimensions' | 'provider' | 'shape';

  constructor(
    columnKey: string,
    field: EmbeddingColumnConfigError['field'],
    detail: string,
  ) {
    super(`embedding_columns["${columnKey}"]: invalid ${field} — ${detail}`);
    this.name = 'EmbeddingColumnConfigError';
    this.columnKey = columnKey;
    this.field = field;
  }
}

// ---- Validation helpers (D12) -----------------------------------------

/**
 * Loud rejection of any registry key that isn't a strict SQL identifier.
 * Catches `embedding"; DROP --`, `embed-1`, leading-digits, etc. at the
 * earliest possible moment.
 */
export function validateColumnKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new EmbeddingColumnConfigError(
      String(key ?? ''),
      'key',
      'must be a non-empty string',
    );
  }
  if (!COLUMN_NAME_REGEX.test(key)) {
    throw new EmbeddingColumnConfigError(
      key,
      'key',
      `must match ${COLUMN_NAME_REGEX} (lowercase identifier, starts with letter or underscore, no quotes/symbols)`,
    );
  }
}

/** `provider:model` string check. Both halves must be non-empty. */
function isParseableProviderModel(s: unknown): s is string {
  if (typeof s !== 'string' || s.length === 0) return false;
  const idx = s.indexOf(':');
  if (idx <= 0) return false;
  if (idx === s.length - 1) return false;
  return true;
}

/**
 * Validates an entry's shape. Throws on any failure with a pinpoint hint.
 * Called by getEmbeddingColumnRegistry at load time AND by config-set
 * before persisting.
 */
export function validateColumnConfig(
  key: string,
  entry: unknown,
): asserts entry is EmbeddingColumnConfig {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new EmbeddingColumnConfigError(
      key,
      'shape',
      'must be a JSON object',
    );
  }
  const e = entry as Record<string, unknown>;

  if (!isParseableProviderModel(e.provider)) {
    throw new EmbeddingColumnConfigError(
      key,
      'provider',
      'must be a non-empty "provider:model" string (e.g. "voyage:voyage-3-large")',
    );
  }
  if (
    typeof e.dimensions !== 'number' ||
    !Number.isInteger(e.dimensions) ||
    e.dimensions < 1 ||
    e.dimensions > MAX_DIMENSIONS
  ) {
    throw new EmbeddingColumnConfigError(
      key,
      'dimensions',
      `must be an integer in [1, ${MAX_DIMENSIONS}]`,
    );
  }
  if (typeof e.type !== 'string' || !ALLOWED_COLUMN_TYPES.has(e.type as 'vector' | 'halfvec')) {
    throw new EmbeddingColumnConfigError(
      key,
      'type',
      `must be one of: ${[...ALLOWED_COLUMN_TYPES].join(', ')}`,
    );
  }
}

// ---- SQL helpers (D12 defense layer 2) --------------------------------

/**
 * Identifier-quoting helper. Wraps `name` in double quotes and doubles
 * any embedded quotes per the Postgres spec. Even though the column
 * name passed in here is already regex-validated (so no embedded
 * quotes are possible), this is the defense-in-depth belt for D12.
 *
 * Returns the quoted form ready to drop into a SQL string. Example:
 *   quoteIdentifier('embedding_voyage') === '"embedding_voyage"'
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Builds the per-engine SQL fragments for a resolved column.
 *
 * Returns:
 *   col      — identifier-quoted column name for SELECT / WHERE / ORDER BY.
 *   castSql  — placeholder cast for the query vector parameter:
 *                '$1::vector'           for type='vector'
 *                '$1::halfvec(<dims>)'  for type='halfvec'
 *
 * Callers interpolate both into the SQL string. The `$1` is the
 * positional parameter that postgres.js / PGLite will bind the query
 * vector to. Different placeholders ($2, $3, etc.) can be obtained
 * by string-substitution from the caller; we standardize on $1 here
 * since both engines use it for the query vector and the cast lives
 * adjacent to the placeholder anyway.
 */
export function buildVectorCastFragment(resolved: ResolvedColumn): {
  col: string;
  castSql: string;
} {
  const col = quoteIdentifier(resolved.name);
  const castSql =
    resolved.type === 'halfvec'
      ? `$1::halfvec(${resolved.dimensions})`
      : `$1::vector`;
  return { col, castSql };
}

// ---- Registry --------------------------------------------------------

/**
 * Returns the merged registry: built-ins (`embedding`, `embedding_image`)
 * + user-declared `embedding_columns`. User declarations win on key
 * collision so power users can override a builtin's dim/provider (e.g.,
 * pointing 'embedding' at a Voyage column on a fresh brain).
 *
 * Throws if any user entry fails D12 validation. Built-ins are
 * derived live from the broader config (embedding_model,
 * embedding_dimensions, embedding_multimodal_model), so a missing
 * embedding_model produces a default 'embedding' entry pointing at the
 * gateway default. The doctor check catches mismatches against actual
 * DB column shape.
 */
export function getEmbeddingColumnRegistry(
  cfg: GBrainConfig,
): Record<string, EmbeddingColumnConfig> {
  // Prototype-pollution safe (codex /ship #1). Plain `{}` inherits from
  // Object.prototype so `registry["constructor"]` returns
  // `Object.prototype.constructor` (a truthy function). Object.create(null)
  // creates a dict with NO prototype so unknown keys are genuinely absent.
  const out: Record<string, EmbeddingColumnConfig> = Object.create(null);

  // Builtin: 'embedding' — derived from primary config keys.
  const embedModel = cfg.embedding_model ?? 'openai:text-embedding-3-large';
  const embedDims =
    typeof cfg.embedding_dimensions === 'number' && cfg.embedding_dimensions > 0
      ? cfg.embedding_dimensions
      : 1536;
  out['embedding'] = {
    provider: embedModel,
    dimensions: embedDims,
    type: 'vector',
  };

  // Builtin: 'embedding_image' — derived from multimodal config keys.
  // Hardcoded 1024d / vector because that's the committed schema shape
  // (see src/schema.sql:158). If the user runs a different multimodal
  // model they can override via the user registry.
  const mmModel = cfg.embedding_multimodal_model ?? 'voyage:voyage-multimodal-3';
  out['embedding_image'] = {
    provider: mmModel,
    dimensions: 1024,
    type: 'vector',
  };

  // User-declared columns. Validate every key + entry at merge time.
  const userColumns = cfg.embedding_columns;
  if (userColumns && typeof userColumns === 'object' && !Array.isArray(userColumns)) {
    for (const [key, value] of Object.entries(userColumns)) {
      validateColumnKey(key);
      validateColumnConfig(key, value);
      out[key] = value;
    }
  }

  return out;
}

/**
 * Resolves the effective column descriptor for one query.
 *
 * Resolution chain:
 *   1. opts.embeddingColumn  (per-call override, e.g. from MCP query op)
 *   2. cfg.search_embedding_column  (DB-plane default)
 *   3. DEFAULT_COLUMN_NAME ('embedding')
 *
 * The resolved name is looked up in the merged registry; unknown names
 * throw EmbeddingColumnNotRegisteredError with a paste-ready hint.
 *
 * When `opts.embeddingColumn` is already a ResolvedColumn (engine-internal
 * shape after the boundary), it's returned as-is so re-resolving is a
 * no-op. This lets hybridSearch resolve once and pass the descriptor down
 * to multiple engine calls without redoing the work.
 */
export function resolveEmbeddingColumn(
  opts: Pick<SearchOpts, 'embeddingColumn'> | undefined,
  cfg: GBrainConfig,
): ResolvedColumn {
  // Fast path: already resolved (engine-internal). Re-validate the
  // descriptor shape before returning (codex /ship #2). SDK callers
  // could pass a hand-rolled object via the public `gbrain/types`
  // surface; runtime check ensures the engine still sees a known-safe
  // shape. The validation is the same shape the resolver applies on
  // the string path.
  const candidate = opts?.embeddingColumn;
  if (
    candidate &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    typeof (candidate as ResolvedColumn).name === 'string'
  ) {
    const r = candidate as ResolvedColumn;
    if (!COLUMN_NAME_REGEX.test(r.name)) {
      throw new EmbeddingColumnNotRegisteredError(r.name, []);
    }
    if (r.type !== 'vector' && r.type !== 'halfvec') {
      throw new EmbeddingColumnConfigError(r.name, 'type', `descriptor.type must be 'vector' or 'halfvec' (got: ${String(r.type)})`);
    }
    if (
      typeof r.dimensions !== 'number' ||
      !Number.isInteger(r.dimensions) ||
      r.dimensions < 1 ||
      r.dimensions > MAX_DIMENSIONS
    ) {
      throw new EmbeddingColumnConfigError(r.name, 'dimensions', `descriptor.dimensions must be an integer in [1, ${MAX_DIMENSIONS}] (got: ${String(r.dimensions)})`);
    }
    return r;
  }

  // String chain.
  const requestedName =
    (typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined) ??
    (typeof cfg.search_embedding_column === 'string' && cfg.search_embedding_column.length > 0
      ? cfg.search_embedding_column
      : undefined) ??
    DEFAULT_COLUMN_NAME;

  // Defense layer 1: regex on the requested name BEFORE registry lookup.
  // Even if someone bypasses load-time validation, the resolver refuses
  // to look up a name that doesn't look like an identifier.
  if (!COLUMN_NAME_REGEX.test(requestedName)) {
    throw new EmbeddingColumnNotRegisteredError(
      requestedName,
      [], // We don't have the registry yet at this point; render later.
    );
  }

  const registry = getEmbeddingColumnRegistry(cfg);
  // Use Object.hasOwn so inherited keys (constructor, hasOwnProperty,
  // __proto__, etc.) cannot resolve. The registry itself uses
  // Object.create(null) but defense-in-depth here too — the codex /ship
  // #1 finding was specifically about resolveEmbeddingColumn's lookup.
  if (!Object.hasOwn(registry, requestedName)) {
    throw new EmbeddingColumnNotRegisteredError(
      requestedName,
      Object.keys(registry).sort(),
    );
  }
  const entry = registry[requestedName];

  return {
    name: requestedName,
    type: entry.type,
    dimensions: entry.dimensions,
    embeddingModel: entry.provider,
  };
}

/**
 * True when the resolved column is the default `embedding` name.
 * Name-based check; does not compare embedding space.
 */
export function isDefaultColumn(resolved: ResolvedColumn): boolean {
  return resolved.name === DEFAULT_COLUMN_NAME;
}

/**
 * True when the resolved column's embedding space matches the
 * `query_cache.embedding` column's space — i.e., it's safe to read
 * from / write to the semantic query cache without dimension or
 * vector-space corruption.
 *
 * Codex /ship finding #4: `isDefaultColumn` is name-based, so a user
 * who overrides the `embedding` builtin to point at a different
 * provider/dim (legitimate use of the registry override semantics)
 * would still have their cache used — but the cache table is sized
 * for the ORIGINAL default embedding dim. Mismatched dim/model means
 * the cache is wrong-space; skip it.
 *
 * Cache-safety criteria:
 *   1. Column name is `embedding` (the cache table only knows about
 *      this column; non-default columns always skip).
 *   2. Resolved dimensions match `cfg.embedding_dimensions` (or
 *      DEFAULT_EMBEDDING_DIMENSIONS=1536 when unset).
 *   3. Resolved provider matches `cfg.embedding_model` (or the OpenAI
 *      default). The model is the "embedding space identifier" — two
 *      models produce non-interchangeable vectors even at the same
 *      dim count.
 *
 * When any of these mismatch, return false so hybridSearchCached
 * skips both the lookup and the writeback paths.
 */
export function isCacheSafe(resolved: ResolvedColumn, cfg: GBrainConfig): boolean {
  if (resolved.name !== DEFAULT_COLUMN_NAME) return false;
  const cfgDims = (typeof cfg.embedding_dimensions === 'number' && cfg.embedding_dimensions > 0)
    ? cfg.embedding_dimensions
    : 1536;
  if (resolved.dimensions !== cfgDims) return false;
  const cfgModel = cfg.embedding_model ?? 'openai:text-embedding-3-large';
  if (resolved.embeddingModel !== cfgModel) return false;
  return true;
}

/** Type guard: is this string a valid BuiltinKey? Useful for callers
 *  that want to special-case the 'embedding_image' multimodal path
 *  without doing a string-compare scattered throughout the code. */
export function isBuiltinColumn(name: string): name is BuiltinKey {
  return (BUILTIN_KEYS as readonly string[]).includes(name);
}

/**
 * Engine-side normalizer. Accepts the legacy SearchOpts.embeddingColumn
 * union (`'embedding'` | `'embedding_image'` | string | ResolvedColumn |
 * undefined) and returns a ResolvedColumn. Engine code calls this once at
 * the top of searchVector / getEmbeddingsByChunkIds. The engine remains
 * config-free — this function reads NO config, only handles the known
 * builtin shapes statically.
 *
 * Behavior:
 *   - ResolvedColumn → returned as-is.
 *   - undefined → builtin 'embedding' descriptor (vector, dims=1536).
 *   - 'embedding' literal → same as undefined.
 *   - 'embedding_image' literal → builtin 'embedding_image' descriptor.
 *   - Any other string → throws EmbeddingColumnNotRegisteredError. The
 *     resolver lives at hybrid/op boundary; bare string names are NOT
 *     accepted at the engine layer (per D11 — engine purity).
 *
 * `dims` for the 'embedding' builtin is hardcoded 1536 here purely as
 * a no-op placeholder; the engine's SQL cast is `$1::vector` (no
 * parenthesized N) when type='vector', so the dims field is unused by
 * `buildVectorCastFragment` and never touches the wire. Tests that
 * care about dims should pass a real descriptor.
 */
export function normalizeEngineColumn(
  embeddingColumn: SearchOpts['embeddingColumn'] | undefined,
): ResolvedColumn {
  // ResolvedColumn descriptor → use as-is.
  if (
    embeddingColumn &&
    typeof embeddingColumn === 'object' &&
    !Array.isArray(embeddingColumn) &&
    typeof (embeddingColumn as ResolvedColumn).name === 'string'
  ) {
    return embeddingColumn as ResolvedColumn;
  }

  // Default + legacy 'embedding' literal.
  if (embeddingColumn === undefined || embeddingColumn === 'embedding') {
    return {
      name: 'embedding',
      type: 'vector',
      dimensions: 1536, // placeholder — not used by $1::vector cast
      embeddingModel: '', // engine doesn't embed; left blank
    };
  }

  // Legacy multimodal literal — committed schema shape per
  // src/schema.sql:158 (vector(1024)).
  if (embeddingColumn === 'embedding_image') {
    return {
      name: 'embedding_image',
      type: 'vector',
      dimensions: 1024,
      embeddingModel: '',
    };
  }

  // Any other raw string at this layer is a programming error — the
  // resolver should have run at the hybrid/op boundary and produced a
  // descriptor. We throw with a paste-ready hint rather than guess.
  throw new EmbeddingColumnNotRegisteredError(String(embeddingColumn), [
    'embedding',
    'embedding_image',
    '<custom name via resolveEmbeddingColumn at hybrid/op boundary>',
  ]);
}
