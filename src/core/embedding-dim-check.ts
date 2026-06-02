/**
 * Detect existing-brain embedding-dimension mismatch (v0.28.5 — A4).
 *
 * `gbrain init --embedding-dimensions N` on an existing brain whose
 * `content_chunks.embedding` column is a different `vector(M)` would
 * silently create a config/column drift: the config gets templated to N
 * but the column stays at M. The first sync write blows up with
 * "expected M, got N" — the silent-corruption pattern v0.28.5 is shipped
 * to kill.
 *
 * Loud-failure path: `gbrain init` AND `gbrain doctor` both consult this
 * helper. On mismatch they emit the same inline ALTER recipe (see
 * `embeddingMismatchMessage`) plus a pointer to `docs/embedding-migrations.md`.
 */

import type { BrainEngine } from './engine.ts';
import { PGVECTOR_HNSW_VECTOR_MAX_DIMS } from './vector-index.ts';
import { gbrainPath } from './config.ts';
import { resolveRecipe } from './ai/model-resolver.ts';
import type { Recipe } from './ai/types.ts';
import { AIConfigError } from './ai/errors.ts';
import {
  supportsVoyageOutputDimension,
  isValidVoyageOutputDim,
  VOYAGE_VALID_OUTPUT_DIMS,
  supportsZeroEntropyDimension,
  isValidZeroEntropyDim,
  ZEROENTROPY_VALID_DIMS,
  isOpenAITextEmbedding3Model,
  isValidOpenAITextEmbedding3Dim,
  maxOpenAITextEmbedding3Dim,
} from './ai/dims.ts';

/**
 * pgvector supports vector(N) columns up to 16000 dimensions. HNSW indexing
 * is capped at PGVECTOR_HNSW_VECTOR_MAX_DIMS (2000); above that, exact scan
 * still works but searches are slower.
 *
 * The preflight resolver below uses this as the hard upper bound so anything
 * pgvector itself would reject (e.g. an accidental `embedding_dimensions: 99999`)
 * fails at init time rather than at first embed.
 */
export const PGVECTOR_COLUMN_MAX_DIMS = 16000;

/**
 * v0.37 (D9): runtime guard for the deferred-setup mode.
 *
 * Init's `--no-embedding` opt-in writes `embedding_disabled: true` to
 * config.json. Every embed callsite (CLI: `gbrain embed`, `gbrain import`;
 * library: `runEmbedCore`) consults this guard so the user gets a clear
 * "configure embedding first" message rather than an opaque gateway error
 * at first vector write.
 *
 * Returns void on the happy path. Throws `EmbeddingDisabledError` when the
 * config has `embedding_disabled: true`. The error type lets callers in
 * CLI mode print a paste-ready hint + exit 1, and library callers (Minion
 * handlers) bubble it back as a structured job failure.
 */
export class EmbeddingDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingDisabledError';
  }
}

export function assertEmbeddingEnabled(cfg: { embedding_disabled?: boolean } | null): void {
  if (cfg?.embedding_disabled) {
    throw new EmbeddingDisabledError(
      'This brain was initialized with `--no-embedding` (deferred setup).\n' +
      'Configure an embedding provider before running embed / import:\n' +
      '  gbrain config set embedding_model <provider>:<model>\n' +
      '  gbrain config set embedding_dimensions <N>\n' +
      '  gbrain init --force --embedding-model <provider>:<model>   # re-init to size schema\n',
    );
  }
}

export interface ColumnDimResult {
  /** Whether the `content_chunks.embedding` column exists. False on a fresh brain. */
  exists: boolean;
  /** Parsed `vector(N)` dimension if known. null when the column doesn't exist or the type isn't vector. */
  dims: number | null;
}

/**
 * Read the actual dimension of `content_chunks.embedding` from the engine.
 *
 * Uses information_schema + a vector-specific catalog query. Returns
 * { exists: false, dims: null } on a fresh brain that doesn't have the
 * column yet. Returns { exists: true, dims: null } on a brain whose
 * column type isn't `vector` (shouldn't happen but defensive).
 */
export async function readContentChunksEmbeddingDim(engine: BrainEngine): Promise<ColumnDimResult> {
  // Probe column existence first to avoid noisy errors on fresh brains.
  const existsRows = await engine.executeRaw<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'content_chunks'
         AND column_name = 'embedding'
     ) AS exists`,
  );
  const exists = !!existsRows?.[0]?.exists;
  if (!exists) return { exists: false, dims: null };

  // pgvector stores dim in pg_type.typmod when atttypmod is set; format_type
  // returns the human-readable `vector(N)`. We parse N out of that.
  const formatRows = await engine.executeRaw<{ formatted: string | null }>(
    `SELECT format_type(a.atttypid, a.atttypmod) AS formatted
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'content_chunks'
        AND a.attname = 'embedding'
        AND NOT a.attisdropped`,
  );
  const formatted = formatRows?.[0]?.formatted ?? null;
  if (!formatted) return { exists: true, dims: null };

  const m = formatted.match(/vector\((\d+)\)/i);
  return { exists: true, dims: m ? parseInt(m[1], 10) : null };
}

/**
 * Build the human-readable recipe printed when an existing brain's column
 * dim doesn't match the requested dim.
 *
 * v0.37 fix wave (Lane D.1): branches on engine kind because the recipes
 * are fundamentally different:
 *
 * - **PGLite** has no native pgvector extension (the WASM build can't
 *   `ALTER COLUMN TYPE vector(N)`), so the only path is wipe-and-reinit
 *   via `gbrain init --pglite --embedding-model X --embedding-dimensions N`.
 *   The recipe derives the active database path so users don't paste a
 *   stale literal that ignores `GBRAIN_HOME` / `--path` / their config.
 * - **Postgres** keeps the existing four-step SQL recipe.
 *
 * The old recipe pointed at `gbrain config set embedding_model X` which
 * is a no-op for the embed pipeline (the embed gateway reads file plane,
 * not DB plane). After Lane C.2 that command refuses; the recipe now
 * points at the actual fix path.
 */
export interface EmbeddingMismatchOpts {
  currentDims: number;
  requestedDims: number;
  requestedModel?: string;
  source?: 'init' | 'doctor' | 'embed';
  /**
   * PGLite vs Postgres branching. Required so the recipe matches the
   * brain's actual engine. Pre-v0.37 default was 'postgres' (the SQL
   * recipe), which produced the wrong recipe for the default install
   * on PGLite.
   */
  engineKind: 'pglite' | 'postgres';
  /**
   * Active PGLite database path. Used only for the PGLite branch; if
   * omitted, falls back to the default `gbrainPath('brain.pglite')`.
   * Resolving at the call site is preferred because the caller knows
   * about `--path` flags and `GBRAIN_HOME` overrides.
   */
  databasePath?: string;
}

export function embeddingMismatchMessage(opts: EmbeddingMismatchOpts): string {
  const { currentDims, requestedDims, requestedModel, source, engineKind, databasePath } = opts;
  const header = source === 'doctor'
    ? `Embedding dimension mismatch detected.`
    : `Refusing to silently re-template existing brain.`;

  if (engineKind === 'pglite') {
    const activePath = databasePath ?? gbrainPath('brain.pglite');
    const modelArg = requestedModel ? ` --embedding-model ${requestedModel}` : '';
    const lines = [
      header,
      ``,
      `  Existing column: vector(${currentDims})`,
      `  Requested:       vector(${requestedDims})${requestedModel ? `  (${requestedModel})` : ''}`,
      ``,
      `Switching dims is destructive: it drops every embedding in your brain.`,
      `PGLite cannot ALTER vector column types (pgvector ships as embedded WASM,`,
      `not a native extension). Wipe-and-reinit is the only path.`,
      ``,
      `Recommended (one command):`,
      ``,
      `  gbrain reinit-pglite${modelArg} --embedding-dimensions ${requestedDims}`,
      ``,
      `Or by hand:`,
      ``,
      `  mv ${activePath} ${activePath}.bak`,
      `  gbrain init --pglite${modelArg} --embedding-dimensions ${requestedDims}`,
      `  gbrain sync   # re-imports your brain repo from disk`,
      `  gbrain embed --stale`,
      ``,
      `Full guide: docs/embedding-migrations.md`,
    ];
    return lines.join('\n');
  }

  // Postgres branch — preserve the existing SQL recipe.
  const supportsHnsw = requestedDims <= PGVECTOR_HNSW_VECTOR_MAX_DIMS;
  const reindexLine = supportsHnsw
    ? `CREATE INDEX IF NOT EXISTS idx_chunks_embedding\n  ON content_chunks USING hnsw (embedding vector_cosine_ops);`
    : `-- Skip reindex. dims=${requestedDims} exceeds pgvector's HNSW cap of ${PGVECTOR_HNSW_VECTOR_MAX_DIMS};\n-- searchVector falls back to exact scan.`;

  const modelArg = requestedModel ? ` --embedding-model ${requestedModel}` : '';
  const lines = [
    header,
    ``,
    `  Existing column: vector(${currentDims})`,
    `  Requested:       vector(${requestedDims})${requestedModel ? `  (${requestedModel})` : ''}`,
    ``,
    `Switching dims is destructive: it drops every embedding in your brain and`,
    `requires a full re-embed (potentially hours and $1-100 in API calls).`,
    ``,
    `Recipe (run against your Postgres brain):`,
    ``,
    `  BEGIN;`,
    `  DROP INDEX IF EXISTS idx_chunks_embedding;`,
    `  ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(${requestedDims});`,
    `  UPDATE content_chunks SET embedding = NULL, embedded_at = NULL;`,
    `  ${reindexLine.split('\n').join('\n  ')}`,
    `  COMMIT;`,
    ``,
    `Then re-init config (file plane is canonical post-v0.37):`,
    `  gbrain init --supabase${modelArg} --embedding-dimensions ${requestedDims}`,
    `  gbrain embed --stale`,
    ``,
    `Full guide: docs/embedding-migrations.md`,
  ];
  return lines.join('\n');
}

// ============================================================================
// v0.37.x — preflight schema-dim resolution (D11 + D12)
//
// Resolves the dim that the PGLite schema substitution will use BEFORE
// `engine.initSchema()` runs, so init can't create a column whose width
// disagrees with the gateway-resolved provider. Pure functions, no I/O —
// init calls them, exits early on error, never writes anything to disk in
// the failure path. The post-init invariant assertion stays as a regression
// guardrail; after this resolver lands it can never fire.
// ============================================================================

/** Tagged-union result of preflight resolution. */
export type ResolveSchemaDimResult =
  | { ok: true; dim: number; model: string; provider: string; recipeDefault: number }
  | { ok: false; error: string };

/** Inputs for the embedding-tier preflight resolver. */
export interface ResolveSchemaEmbeddingDimOpts {
  /** `provider:model` string (e.g. `openai:text-embedding-3-large`). Required. */
  embedding_model: string;
  /** Explicit override (Matryoshka step, custom dim). Optional. */
  embedding_dimensions?: number;
}

/**
 * Resolve the dim that will land in `content_chunks.embedding`'s vector(N)
 * column. Caller is `init.ts:initPGLite` before any DB write happens.
 *
 * Validations:
 *  1. `embedding_model` parses as `provider:model`.
 *  2. Provider is a known recipe.
 *  3. Recipe declares an `embedding` touchpoint.
 *  4. Resolved dim is a positive integer.
 *  5. Resolved dim ≤ PGVECTOR_COLUMN_MAX_DIMS (16000).
 *  6. If user passed `embedding_dimensions`, it either matches
 *     `recipe.touchpoints.embedding.default_dims` OR is in the recipe's
 *     `dims_options` list (Matryoshka providers). Otherwise reject — the
 *     user picked a model that doesn't support custom dims.
 */
export function resolveSchemaEmbeddingDim(opts: ResolveSchemaEmbeddingDimOpts): ResolveSchemaDimResult {
  try {
    const { recipe, parsed } = resolveRecipe(opts.embedding_model);
    const tp = recipe.touchpoints.embedding;
    if (!tp) {
      return {
        ok: false,
        error:
          `Provider "${recipe.id}" does not offer embedding models. ` +
          `Pick a recipe with an embedding touchpoint (gbrain providers list).`,
      };
    }
    return validateDimAgainstTouchpoint(parsed.modelId, recipe, tp.default_dims, tp.dims_options, opts.embedding_dimensions);
  } catch (err) {
    return { ok: false, error: err instanceof AIConfigError ? err.message : String(err) };
  }
}

/** Inputs for the multimodal-tier preflight resolver (D12). */
export interface ResolveSchemaMultimodalDimOpts {
  /** `provider:model` string for the multimodal endpoint. Required. */
  embedding_multimodal_model: string;
  /** Explicit override. Optional. */
  embedding_multimodal_dimensions?: number;
}

/**
 * Resolve the dim that will land in `content_chunks.embedding_multimodal`'s
 * vector(N) column. Mirrors `resolveSchemaEmbeddingDim` but also checks the
 * recipe-level `supports_multimodal` flag and the per-model
 * `multimodal_models` allow-list (some recipes like Voyage mix text-only
 * and multimodal models in one embedding touchpoint).
 */
export function resolveSchemaMultimodalDim(opts: ResolveSchemaMultimodalDimOpts): ResolveSchemaDimResult {
  try {
    const { recipe, parsed } = resolveRecipe(opts.embedding_multimodal_model);
    const tp = recipe.touchpoints.embedding;
    if (!tp) {
      return {
        ok: false,
        error:
          `Provider "${recipe.id}" does not offer embedding models. ` +
          `Pick a recipe with an embedding touchpoint that supports multimodal input.`,
      };
    }
    if (!tp.supports_multimodal) {
      return {
        ok: false,
        error:
          `Provider "${recipe.id}" does not support multimodal embeddings. ` +
          `Configured recipes that do: voyage (voyage-multimodal-3). ` +
          `Run \`gbrain providers list\` to see touchpoint coverage.`,
      };
    }
    if (tp.multimodal_models && !tp.multimodal_models.includes(parsed.modelId)) {
      return {
        ok: false,
        error:
          `Model "${parsed.modelId}" is not in provider "${recipe.id}"'s multimodal allow-list ` +
          `(allowed: ${tp.multimodal_models.join(', ')}). ` +
          `Pick a multimodal-capable model from this provider.`,
      };
    }
    return validateDimAgainstTouchpoint(parsed.modelId, recipe, tp.default_dims, tp.dims_options, opts.embedding_multimodal_dimensions);
  } catch (err) {
    return { ok: false, error: err instanceof AIConfigError ? err.message : String(err) };
  }
}

/**
 * Shared validation of a requested dim against a recipe touchpoint's
 * declared dims, including provider-specific Matryoshka allow-lists.
 *
 * Recipes (`src/core/ai/recipes/*.ts`) declare `default_dims` per touchpoint
 * but do NOT generally encode Matryoshka steps as `dims_options`. The
 * per-provider valid-dim allow-lists live in `src/core/ai/dims.ts`:
 *   - `VOYAGE_VALID_OUTPUT_DIMS` (256/512/1024/2048) for flexible Voyage models
 *   - `ZEROENTROPY_VALID_DIMS` (2560/1280/640/320/160/80/40) for ZE zembed-1
 *   - OpenAI text-embedding-3-* accepts ANY positive integer up to the
 *     model's native size (1536 small / 3072 large)
 *
 * Validation order:
 *   1. recipe-declared `dims_options` (highest precedence — recipe author
 *      knows their backend)
 *   2. provider-specific dim.ts allow-lists (for known Matryoshka providers)
 *   3. fall through to "this model only emits default_dims" rejection
 */
function validateDimAgainstTouchpoint(
  modelId: string,
  recipe: Recipe,
  defaultDims: number,
  dimsOptions: number[] | undefined,
  requestedDims: number | undefined,
): ResolveSchemaDimResult {
  const dim = requestedDims ?? defaultDims;

  if (!Number.isInteger(dim) || dim <= 0) {
    return {
      ok: false,
      error: `Embedding dimensions must be a positive integer; got ${JSON.stringify(dim)}.`,
    };
  }
  if (dim > PGVECTOR_COLUMN_MAX_DIMS) {
    return {
      ok: false,
      error:
        `Embedding dimensions ${dim} exceed pgvector's column cap of ${PGVECTOR_COLUMN_MAX_DIMS}. ` +
        `Pick a model that returns ≤${PGVECTOR_COLUMN_MAX_DIMS} dims.`,
    };
  }

  if (requestedDims !== undefined && requestedDims !== defaultDims) {
    // User asked for a non-default dim. Walk the precedence chain.
    const customDimOk = isCustomDimValidForProvider(recipe, modelId, requestedDims, dimsOptions);
    if (!customDimOk.valid) {
      return { ok: false, error: customDimOk.error };
    }
  }

  return {
    ok: true,
    dim,
    model: `${recipe.id}:${modelId}`,
    provider: recipe.id,
    recipeDefault: defaultDims,
  };
}

interface CustomDimCheck {
  valid: boolean;
  error: string;
}

function isCustomDimValidForProvider(
  recipe: Recipe,
  modelId: string,
  requestedDims: number,
  dimsOptions: number[] | undefined,
): CustomDimCheck {
  // Tier 1: recipe-declared dims_options.
  if (dimsOptions && dimsOptions.length > 0) {
    if (dimsOptions.includes(requestedDims)) return { valid: true, error: '' };
    return {
      valid: false,
      error:
        `Provider "${recipe.id}" model "${modelId}" rejects custom dimensions ${requestedDims} ` +
        `(allowed: ${dimsOptions.join(', ')}).`,
    };
  }

  // Tier 2: provider-specific Matryoshka allow-lists.
  if (recipe.id === 'voyage' && supportsVoyageOutputDimension(modelId)) {
    if (isValidVoyageOutputDim(requestedDims)) return { valid: true, error: '' };
    return {
      valid: false,
      error:
        `Voyage model "${modelId}" rejects custom dimensions ${requestedDims} ` +
        `(allowed: ${VOYAGE_VALID_OUTPUT_DIMS.join(', ')}).`,
    };
  }
  if (recipe.id === 'zeroentropyai' && supportsZeroEntropyDimension(modelId)) {
    if (isValidZeroEntropyDim(requestedDims)) return { valid: true, error: '' };
    return {
      valid: false,
      error:
        `ZeroEntropy model "${modelId}" does not support custom dimensions ${requestedDims} ` +
        `(allowed: ${ZEROENTROPY_VALID_DIMS.join(', ')}).`,
    };
  }
  if (recipe.id === 'openai' && isOpenAITextEmbedding3Model(modelId)) {
    if (isValidOpenAITextEmbedding3Dim(modelId, requestedDims)) return { valid: true, error: '' };
    const maxDim = maxOpenAITextEmbedding3Dim(modelId);
    return {
      valid: false,
      error:
        `OpenAI ${modelId} accepts dimensions 1..${maxDim}, got ${requestedDims}.`,
    };
  }

  // Tier 3: provider not known to support custom dims at all.
  return {
    valid: false,
    error:
      `Provider "${recipe.id}" model "${modelId}" does not support custom dimensions ${requestedDims} ` +
      `(this model only emits its default vector size). ` +
      `Either drop --embedding-dimensions or pick a Matryoshka-aware model.`,
  };
}

// ───────────────────────────────────────────────────────────────────────
// v0.41.15.0 (T5 + T6) — facts.embedding column drift detection.
//
// Migration v40 reads `config.embedding_dimensions` at MIGRATION time and
// creates `facts.embedding` as `halfvec(N)` (or `vector(N)` on pgvector
// < 0.7). If the user later changes embedding provider without re-running
// migrations, the column type stays at the old N and the first insert
// dies with an opaque pgvector error. Two surfaces close the gap:
//
//   1. `readFactsEmbeddingDim(engine)` — column-type probe used by the
//      `gbrain doctor` `embedding_dim_mismatch` check to surface drift.
//   2. `assertFactsEmbeddingDimMatchesConfig(engine)` — preflight thrown
//      at the top of every fact-writing path (extract-conversation-facts
//      startup, the cycle extract_facts phase, facts:absorb op). Result
//      cached per process so the SELECT runs once per startup.
//
// Both helpers handle the `vector(N)` AND `halfvec(N)` shapes because
// migration v40 falls back to `vector` on pgvector < 0.7 (codex #19).
// ───────────────────────────────────────────────────────────────────────

/**
 * Discriminated result of `readFactsEmbeddingDim`. Carries the column
 * type (vector vs halfvec) alongside the dim so callers can render
 * paste-ready ALTER recipes that target the right type + opclass.
 */
export interface FactsColumnDimResult {
  /** Whether the `facts.embedding` column exists (false on pre-v40 brains). */
  exists: boolean;
  /** Parsed dim from format_type, or null when the column doesn't exist. */
  dims: number | null;
  /** Column type — `halfvec` (pgvector >=0.7) or `vector` (older). */
  columnType: 'halfvec' | 'vector' | null;
}

/**
 * Read the actual width + type of `facts.embedding`. Mirrors
 * `readContentChunksEmbeddingDim` but for the facts table; covers
 * BOTH `vector(N)` and `halfvec(N)` shapes per codex #19.
 *
 * Returns `{exists: false, dims: null, columnType: null}` on pre-v40
 * brains (facts table absent) and a fully-populated result otherwise.
 */
export async function readFactsEmbeddingDim(engine: BrainEngine): Promise<FactsColumnDimResult> {
  // Probe the embedding column directly. The facts table itself may
  // exist on a partial-v40 brain but without the embedding column on
  // very-old upgrade chains; both null branches yield exists:false.
  const existsRows = await engine.executeRaw<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'facts'
         AND column_name = 'embedding'
     ) AS exists`,
  );
  const exists = !!existsRows?.[0]?.exists;
  if (!exists) return { exists: false, dims: null, columnType: null };

  const formatRows = await engine.executeRaw<{ formatted: string | null }>(
    `SELECT format_type(a.atttypid, a.atttypmod) AS formatted
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'facts'
        AND a.attname = 'embedding'
        AND NOT a.attisdropped`,
  );
  const formatted = formatRows?.[0]?.formatted ?? null;
  if (!formatted) return { exists: true, dims: null, columnType: null };

  // Order matters: try `halfvec(N)` BEFORE `vector(N)` because the
  // half-vector regex would otherwise be shadowed by the generic
  // `vector` match (halfvec is a separate pgvector type that also
  // contains "vec" as a substring).
  const halfMatch = formatted.match(/halfvec\((\d+)\)/i);
  if (halfMatch) {
    return { exists: true, dims: parseInt(halfMatch[1], 10), columnType: 'halfvec' };
  }
  const vecMatch = formatted.match(/vector\((\d+)\)/i);
  if (vecMatch) {
    return { exists: true, dims: parseInt(vecMatch[1], 10), columnType: 'vector' };
  }
  return { exists: true, dims: null, columnType: null };
}

/** Tagged error thrown by `assertFactsEmbeddingDimMatchesConfig` on drift. */
export class FactsEmbeddingDimMismatchError extends Error {
  readonly tag = 'FACTS_EMBEDDING_DIM_MISMATCH' as const;
  constructor(
    message: string,
    public readonly columnDims: number,
    public readonly configuredDims: number,
    public readonly columnType: 'halfvec' | 'vector',
  ) {
    super(message);
    this.name = 'FactsEmbeddingDimMismatchError';
  }
}

/**
 * v0.41.15.0 (D15): build the paste-ready ALTER recipe for facts dim
 * drift (codex #18). Postgres-only — facts.embedding ALTER on PGLite
 * is not supported by the embedded pgvector WASM. The recipe is the
 * full DROP INDEX + ALTER USING + CREATE INDEX flow, NOT a bare
 * `ALTER TYPE ... REINDEX` (which doesn't actually rewrite the index
 * after a type change).
 */
export function buildFactsAlterRecipe(
  columnDims: number,
  configuredDims: number,
  columnType: 'halfvec' | 'vector',
): string {
  const opclass = columnType === 'halfvec' ? 'halfvec_cosine_ops' : 'vector_cosine_ops';
  const targetType = columnType === 'halfvec' ? `halfvec(${configuredDims})` : `vector(${configuredDims})`;
  return [
    `-- ALTER ${columnType}(${columnDims}) → ${columnType}(${configuredDims}) on indexed column.`,
    `-- HOLD a maintenance window: this rewrites every row's embedding.`,
    `-- Coordinate with any active extract-conversation-facts backfill.`,
    `DROP INDEX IF EXISTS idx_facts_embedding_hnsw;`,
    `ALTER TABLE facts ALTER COLUMN embedding TYPE ${targetType}`,
    `  USING embedding::${targetType};`,
    `CREATE INDEX idx_facts_embedding_hnsw`,
    `  ON facts USING hnsw (embedding ${opclass})`,
    `  WHERE embedding IS NOT NULL AND expired_at IS NULL;`,
  ].join('\n');
}

/**
 * Per-process cache for `assertFactsEmbeddingDimMatchesConfig`. The
 * probe is a cheap SELECT but runs at the top of every fact-writing
 * call site; caching keeps the cost off the hot path. The cache
 * stores the engine's `kind + a synthetic instance marker` so a fresh
 * engine connection in the same process re-probes. Test seam below
 * clears the cache between cases.
 */
const _factsDimCheckCache = new WeakMap<BrainEngine, { ok: true } | { err: FactsEmbeddingDimMismatchError }>();

/** Test seam: clear the per-process facts-dim cache. */
export function _resetFactsDimCheckCacheForTest(): void {
  // WeakMap has no clear() — but tests can pass fresh engine instances
  // to get fresh probes. This noop helper documents the intent.
}

/**
 * Preflight check: throws FactsEmbeddingDimMismatchError when the
 * configured embedding dimensions don't match the facts.embedding
 * column width. Called at the top of every fact-writing path so users
 * see a clear paste-ready ALTER hint BEFORE the first insert (which
 * would otherwise fail with the opaque pgvector "expected vector(N),
 * got vector(M)" error).
 *
 * Caches the result per engine instance for the process lifetime —
 * one SELECT at startup, zero per-page cost. Successful probes return
 * void; mismatches throw the tagged class.
 *
 * Skipped on:
 *   - PGLite engines (the facts table on PGLite uses the same
 *     embedded pgvector that migrated content_chunks; if dim drift
 *     exists, the `--no-embedding` runtime guard already covers it).
 *   - Brains without the facts.embedding column (pre-v40 install
 *     chains; the migration that creates the column hasn't run, so
 *     no possible drift exists).
 *   - Brains with no `embedding_dimensions` config (fresh installs;
 *     gateway defaults take over and align with migration defaults).
 */
export async function assertFactsEmbeddingDimMatchesConfig(engine: BrainEngine): Promise<void> {
  const cached = _factsDimCheckCache.get(engine);
  if (cached) {
    if ('err' in cached) throw cached.err;
    return;
  }

  // PGLite + non-Postgres engines: skip. (PGLite ships a single
  // pgvector version; the column and config are wired together at
  // initSchema time, so the bug class doesn't apply.)
  if (engine.kind !== 'postgres') {
    _factsDimCheckCache.set(engine, { ok: true });
    return;
  }

  const col = await readFactsEmbeddingDim(engine);
  if (!col.exists || col.dims === null || col.columnType === null) {
    // No facts.embedding column → migration v40 hasn't run yet → no
    // possible drift. Cache as ok; the migration runner will pick up
    // the right dims from config when it lands.
    _factsDimCheckCache.set(engine, { ok: true });
    return;
  }

  // Read the configured dims directly from the gateway. This matches
  // what gateway.embed() will produce — single source of truth.
  let configuredDims: number;
  try {
    // Lazy-import to avoid the gateway pulling in at module-load
    // time (matters for tests that mock the gateway).
    const { getEmbeddingDimensions } = await import('./ai/gateway.ts');
    configuredDims = getEmbeddingDimensions();
  } catch {
    // Gateway not configured (rare; usually means the brain hasn't
    // been initialized yet). Skip the check — the fact-writing path
    // will fail with a clearer "gateway not configured" error.
    _factsDimCheckCache.set(engine, { ok: true });
    return;
  }

  if (col.dims === configuredDims) {
    _factsDimCheckCache.set(engine, { ok: true });
    return;
  }

  const recipe = buildFactsAlterRecipe(col.dims, configuredDims, col.columnType);
  const message = [
    `facts.embedding is ${col.columnType}(${col.dims}) but configured embedding_dimensions is ${configuredDims}.`,
    `Refusing to attempt fact inserts that would fail with an opaque pgvector error.`,
    ``,
    `Paste-ready fix (review carefully — this rewrites the facts table):`,
    ``,
    recipe,
    ``,
    `Or run \`gbrain doctor --json\` for the full diagnostic + fix surface.`,
  ].join('\n');
  const err = new FactsEmbeddingDimMismatchError(
    message,
    col.dims,
    configuredDims,
    col.columnType,
  );
  _factsDimCheckCache.set(engine, { err });
  throw err;
}
