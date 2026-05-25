import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'fs';
import { isAbsolute, join } from 'path';
import { homedir } from 'os';
import type { EngineConfig, EmbeddingColumnConfig } from './types.ts';

/**
 * Where is the active DB URL coming from? Pure introspection, no connection
 * attempt. Used by `gbrain doctor --fast` so the user gets a precise message
 * instead of the misleading "No database configured" when GBRAIN_DATABASE_URL
 * (or DATABASE_URL) is actually set.
 *
 * Precedence matches loadConfig(): env vars win over config-file URL. Returns
 * null only when NO source provides a URL at all.
 */
export type DbUrlSource =
  | 'env:GBRAIN_DATABASE_URL'
  | 'env:DATABASE_URL'
  | 'config-file'
  | 'config-file-path' // PGLite: config file present, no URL but database_path set
  | null;

// Internal aliases retained for backwards compatibility with the existing call
// sites below. They forward to the exported configDir()/configPath() so
// GBRAIN_HOME is honored uniformly. Lazy: never call homedir() at module scope.
function getConfigDir() { return configDir(); }
function getConfigPath() { return configPath(); }

export interface GBrainConfig {
  engine: 'postgres' | 'pglite';
  database_url?: string;
  database_path?: string;
  openai_api_key?: string;
  anthropic_api_key?: string;
  /**
   * ZeroEntropy API key. v0.37 fix wave (CDX2-5+6): ZE became the default
   * embedding + reranker provider in v0.36 but lacked a file-plane config
   * slot. `gbrain config set zeroentropy_api_key X` wrote DB plane,
   * `loadConfig` only merged OpenAI/Anthropic, and `buildGatewayConfig`
   * at cli.ts:1401 only mapped those two — so the key never reached the
   * embed pipeline. Now wired through: file plane → loadConfig env
   * merge → buildGatewayConfig env dict → recipe reads ZEROENTROPY_API_KEY.
   */
  zeroentropy_api_key?: string;
  /** AI gateway config (v0.14+). v0.36+ default: "zeroentropyai:zembed-1" / 1280 / "anthropic:claude-haiku-4-5-20251001". */
  embedding_model?: string;
  embedding_dimensions?: number;
  /**
   * v0.37 (D9): user opted into deferred-setup mode at init time via
   * `gbrain init --no-embedding`. When true, embed callsites and `gbrain
   * import` refuse with a `gbrain config set embedding_model <id>` hint
   * rather than proceeding with a default that may not match a real key.
   * Mutually exclusive with `embedding_model` being set — init writes one
   * or the other, never both.
   */
  embedding_disabled?: boolean;
  expansion_model?: string;
  /**
   * Default chat model for `gateway.chat()` callers (v0.27+).
   * Default: "anthropic:claude-sonnet-4-6" (dateless per Anthropic's v0.31.12+ model-ID format).
   */
  chat_model?: string;
  /**
   * Optional silent-refusal fallback chain for `chatWithFallback()` (v0.27+).
   * Each entry is a "provider:modelId" string. Blocked from critic/judge/
   * synthesize flows in their respective handlers (per D13 review decision).
   */
  chat_fallback_chain?: string[];
  /** Optional base URL overrides for openai-compatible providers (keyed by recipe id). */
  provider_base_urls?: Record<string, string>;
  /**
   * Optional storage backend config (S3/Supabase/local). Shape matches
   * `StorageConfig` in `./storage.ts`. Typed as `unknown` here to avoid
   * a cyclic import; callers pass this through `createStorage()` which
   * validates the shape at runtime.
   */
  storage?: unknown;
  /**
   * v0.25.0 — session capture settings. Read via file-plane `loadConfig()`
   * at process boot (NOT `gbrain config set` which writes the DB plane —
   * those are different stores). Edit `~/.gbrain/config.json` directly.
   * All fields default to ON — capture and scrubbing both opt-out.
   */
  /**
   * v0.41 — autopilot daemon configuration. Currently houses the nightly
   * quality probe feature flag (default OFF — opt-in to protect API spend
   * on fresh installs). Flag is gated INSIDE the autopilot tick body;
   * absence means "do not run nightly probe."
   */
  autopilot?: {
    nightly_quality_probe?: {
      /** Enable the nightly probe in the autopilot loop. Defaults to false. */
      enabled?: boolean;
      /**
       * Cost cap (USD) per probe invocation. Defaults to 5.
       * Worst case: 5 × 30 nights ≈ $150/month per brain.
       */
      max_usd?: number;
    };
  };
  eval?: {
    /** false disables capture entirely. Defaults to true. */
    capture?: boolean;
    /** false disables PII scrubbing before insert. Defaults to true. */
    scrub_pii?: boolean;
  };

  /**
   * v0.27.1 — multimodal ingestion flags. Default off; opt-in.
   *
   * Unlike `embedding_model` / `embedding_dimensions` (which size the
   * schema and must be set before initSchema), these flags only affect
   * runtime behavior. They live in the DB plane primarily — `gbrain config
   * set embedding_multimodal true` flips the gate without touching the file.
   * loadConfigWithEngine() merges DB config on top of file/env. Env vars
   * still win as the operator escape hatch.
   */
  embedding_multimodal?: boolean;
  /** Model override for multimodal embeddings (e.g. "voyage:voyage-multimodal-3"). */
  embedding_multimodal_model?: string;
  embedding_image_ocr?: boolean;
  embedding_image_ocr_model?: string;

  /**
   * v0.36 — embedding-column registry (D7). Maps a content_chunks column
   * name to its provider + dimensions + pgvector type. Both keys live in
   * the DB plane (`gbrain config set ...`) so users can flip without
   * editing files. Resolver merges this with `BUILTIN_EMBEDDING_COLUMNS`
   * (which derive their provider from `embedding_model` /
   * `embedding_multimodal_model`).
   *
   * Validation lives in `src/core/search/embedding-column.ts` per D12 —
   * keys must match `/^[a-z_][a-z0-9_]*$/`, type in {vector, halfvec},
   * dimensions 1..8192, provider parseable as `provider:model`.
   */
  embedding_columns?: Record<string, EmbeddingColumnConfig>;
  /**
   * v0.36 — name of the column hybridSearch uses by default. Per-call
   * `SearchOpts.embeddingColumn` overrides this; absent => 'embedding'.
   * Validated against the merged `embedding_columns` registry at config-
   * set time and on hybridSearch entry.
   */
  search_embedding_column?: string;

  /**
   * v0.41 content-sanity tunables. Read via file/env/DB plane (D1: lint
   * lifts to DB config when reachable). Resolution order:
   * env > file > DB > defaults from `src/core/content-sanity.ts`.
   *
   * Both lint AND ingest go through the same effective resolution so a
   * `gbrain config set content_sanity.bytes_block N` flips both surfaces
   * uniformly. CI without `~/.gbrain/` falls through to env/defaults.
   */
  content_sanity?: {
    /** Stderr warn + lint `huge-page` rule fires above this (UTF-8 bytes
     *  of compiled_truth + timeline). Default: 50_000. Env override:
     *  `GBRAIN_PAGE_WARN_BYTES`. */
    bytes_warn?: number;
    /** Soft-block: page writes with `frontmatter.embed_skip` set but
     *  embedder skips on next sweep. Default: 500_000. Env override:
     *  `GBRAIN_PAGE_BLOCK_BYTES`. */
    bytes_block?: number;
    /** Master switch for the built-in junk-pattern set. Default: true.
     *  Env override: `GBRAIN_NO_JUNK_PATTERNS=1` flips to false. */
    junk_patterns_enabled?: boolean;
    /** Master kill-switch for all sanity checks. When true, ingest emits
     *  loud stderr per page but lets everything through. Default: false.
     *  Env override: `GBRAIN_NO_SANITY=1` flips to true. */
    disabled?: boolean;
  };

  /**
   * Thin-client mode (multi-topology v1). When set, this install does NOT
   * have a local DB; it talks to a remote `gbrain serve --http` over MCP.
   * The CLI dispatch guard in `src/cli.ts` checks for this field BEFORE
   * `connectEngine` and refuses any DB-bound subcommand. The `engine` field
   * above is still populated (default-inferred) but never used.
   *
   * Two URLs because OAuth discovery + `/token` live at the issuer root,
   * while tool dispatch lives at `/mcp`. They compose from a common base
   * in the typical setup but the config keeps them explicit so reverse-proxy
   * topologies work.
   *
   * `oauth_client_secret` can also be supplied via the
   * `GBRAIN_REMOTE_CLIENT_SECRET` env var (preferred for headless agents);
   * env-var value wins when both are present.
   */
  remote_mcp?: {
    issuer_url: string;
    mcp_url: string;
    oauth_client_id: string;
    oauth_client_secret?: string;
  };

  /**
   * v0.38 — active schema pack name (D13 tier 6 in the 7-tier resolution
   * chain). The pack drives type inference, alias closure for search,
   * link-verb regexes, expert-routing flags, and enrichment dispatch.
   * Default: `gbrain-base` (reproduces pre-v0.38 hardcoded behavior).
   *
   * Resolution priority (highest → lowest, per D13):
   *   1. Per-call SearchOpts.schema_pack (CLI-only; rejected for remote callers)
   *   2. GBRAIN_SCHEMA_PACK env var
   *   3. Per-source DB config `schema_pack.source.<id>`
   *   4. Brain-wide DB config `schema_pack`
   *   5. gbrain.yml `schema:` section
   *   6. THIS field (~/.gbrain/config.json)
   *   7. Default 'gbrain-base'
   *
   * `gbrain config set schema_pack <name>` writes the DB plane (tier 4);
   * editing this file directly writes tier 6. Env var (tier 2) is the
   * operator escape hatch.
   */
  schema_pack?: string;
}

/**
 * True when this install is configured as a thin client of a remote
 * `gbrain serve --http`. Single source of truth for the "is this a
 * thin-client install?" check used by the CLI dispatch guard, doctor
 * branch, and remote subcommands.
 */
export function isThinClient(config: GBrainConfig | null): boolean {
  return !!config?.remote_mcp;
}

/**
 * Load config with credential precedence: env vars > config file.
 * Plugin config is handled by the plugin runtime injecting env vars.
 */
// v0.36.x #1086: translate legacy `provider` + `model` config shape (seen in
// pre-v0.32 docs and some community templates) to the canonical
// `embedding_model: "<provider>:<model>"`. Without this translation, sync
// and embed silently fell through to the hardcoded OpenAI default, blocking
// Voyage / Cohere / Mistral users from using their configured provider.
function migrateLegacyEmbeddingConfig(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.embedding_model !== undefined) return raw;
  const provider = typeof raw.provider === 'string' ? raw.provider : undefined;
  const model = typeof raw.model === 'string' ? raw.model : undefined;
  if (!provider || !model) return raw;
  // Strip the legacy keys to avoid downstream confusion. Emit a one-line
  // stderr nudge so the operator updates their config to the canonical shape.
  const rest = { ...raw };
  delete rest.provider;
  delete rest.model;
  rest.embedding_model = `${provider}:${model}`;
  console.warn(
    `[config] legacy "provider" + "model" detected; using "${rest.embedding_model}".` +
    ` Rewrite ~/.gbrain/config.json to: "embedding_model": "${rest.embedding_model}".`,
  );
  return rest;
}

/**
 * File-only config loader. Reads ~/.gbrain/config.json and applies the
 * legacy embedding-config migration shim. Does NOT merge env vars, does
 * NOT infer engine kind from DATABASE_URL.
 *
 * Used by `gbrain init`'s config-merge path (B.4) where loading
 * `loadConfig()` would poison the saved file with transient env state
 * (e.g. a CI run with DATABASE_URL set writes a Postgres config.json
 * for a PGLite brain). Read-path callers should keep using `loadConfig()`
 * because env vars are the canonical operator escape hatch at runtime.
 *
 * v0.37 fix wave (CDX-5 from round 1). Pinned by test/config-file-only-loader.test.ts.
 */
export function loadConfigFileOnly(): GBrainConfig | null {
  try {
    const raw = readFileSync(getConfigPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return migrateLegacyEmbeddingConfig(parsed) as unknown as GBrainConfig;
  } catch {
    return null;
  }
}

export function loadConfig(): GBrainConfig | null {
  let fileConfig: GBrainConfig | null = null;
  try {
    const raw = readFileSync(getConfigPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    fileConfig = migrateLegacyEmbeddingConfig(parsed) as unknown as GBrainConfig;
  } catch { /* no config file */ }

  // Try env vars
  const dbUrl = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;

  if (!fileConfig && !dbUrl) return null;

  // Infer engine type. A DATABASE_URL-style env var is always a Postgres
  // connection target and must override a file-backed PGLite engine
  // selection; otherwise direct-script / operator paths can silently hit
  // the local PGLite brain while claiming to use the env URL. The PGLite
  // database_path is also cleared when dbUrl is set so toEngineConfig
  // doesn't pass a stale path through alongside the URL.
  const inferredEngine: 'postgres' | 'pglite' = dbUrl
    ? 'postgres'
    : fileConfig?.engine || (fileConfig?.database_path ? 'pglite' : 'postgres');

  // Merge: env vars override config file. READ only — never mutate process.env.
  const merged = {
    ...fileConfig,
    engine: inferredEngine,
    ...(dbUrl ? { database_url: dbUrl } : {}),
    ...(dbUrl ? { database_path: undefined } : {}),
    ...(process.env.OPENAI_API_KEY ? { openai_api_key: process.env.OPENAI_API_KEY } : {}),
    ...(process.env.ANTHROPIC_API_KEY ? { anthropic_api_key: process.env.ANTHROPIC_API_KEY } : {}),
    ...(process.env.ZEROENTROPY_API_KEY ? { zeroentropy_api_key: process.env.ZEROENTROPY_API_KEY } : {}),
    ...(process.env.GBRAIN_EMBEDDING_MODEL ? { embedding_model: process.env.GBRAIN_EMBEDDING_MODEL } : {}),
    ...(process.env.GBRAIN_EMBEDDING_DIMENSIONS ? { embedding_dimensions: parseInt(process.env.GBRAIN_EMBEDDING_DIMENSIONS, 10) } : {}),
    ...(process.env.GBRAIN_EXPANSION_MODEL ? { expansion_model: process.env.GBRAIN_EXPANSION_MODEL } : {}),
    ...(process.env.GBRAIN_CHAT_MODEL ? { chat_model: process.env.GBRAIN_CHAT_MODEL } : {}),
    ...(process.env.GBRAIN_CHAT_FALLBACK_CHAIN
      ? { chat_fallback_chain: process.env.GBRAIN_CHAT_FALLBACK_CHAIN.split(',').map(s => s.trim()).filter(Boolean) }
      : {}),
    ...(process.env.GBRAIN_EMBEDDING_MULTIMODAL
      ? { embedding_multimodal: process.env.GBRAIN_EMBEDDING_MULTIMODAL === 'true' }
      : {}),
    ...(process.env.GBRAIN_EMBEDDING_IMAGE_OCR
      ? { embedding_image_ocr: process.env.GBRAIN_EMBEDDING_IMAGE_OCR === 'true' }
      : {}),
    ...(process.env.GBRAIN_EMBEDDING_MULTIMODAL_MODEL
      ? { embedding_multimodal_model: process.env.GBRAIN_EMBEDDING_MULTIMODAL_MODEL }
      : {}),
    ...(process.env.GBRAIN_EMBEDDING_IMAGE_OCR_MODEL
      ? { embedding_image_ocr_model: process.env.GBRAIN_EMBEDDING_IMAGE_OCR_MODEL }
      : {}),
    ...(process.env.GBRAIN_REMOTE_CLIENT_SECRET && fileConfig?.remote_mcp
      ? { remote_mcp: { ...fileConfig.remote_mcp, oauth_client_secret: process.env.GBRAIN_REMOTE_CLIENT_SECRET } }
      : {}),
  };

  // v0.41 content-sanity env overrides. Built up as a sparse object so
  // env presence wins over file/DB only for the specific keys set,
  // matching the precedence pattern used elsewhere in loadConfig.
  // The env vars use natural names (GBRAIN_NO_SANITY=1 is more
  // operator-friendly than GBRAIN_CONTENT_SANITY_DISABLED=true).
  const envContentSanity: GBrainConfig['content_sanity'] = {};
  if (process.env.GBRAIN_PAGE_WARN_BYTES) {
    const n = parseInt(process.env.GBRAIN_PAGE_WARN_BYTES, 10);
    if (Number.isFinite(n) && n > 0) envContentSanity.bytes_warn = n;
  }
  if (process.env.GBRAIN_PAGE_BLOCK_BYTES) {
    const n = parseInt(process.env.GBRAIN_PAGE_BLOCK_BYTES, 10);
    if (Number.isFinite(n) && n > 0) envContentSanity.bytes_block = n;
  }
  if (process.env.GBRAIN_NO_JUNK_PATTERNS === '1') {
    envContentSanity.junk_patterns_enabled = false;
  }
  if (process.env.GBRAIN_NO_SANITY === '1') {
    envContentSanity.disabled = true;
  }
  // Only attach the field when at least one env var was set, so the
  // sparse-merge semantics elsewhere in loadConfigWithEngine work
  // (env presence => "this key already has a value, don't read DB").
  if (Object.keys(envContentSanity).length > 0) {
    (merged as GBrainConfig).content_sanity = {
      ...(fileConfig?.content_sanity ?? {}),
      ...envContentSanity,
    };
  }

  return merged as GBrainConfig;
}

/**
 * v0.27.1 — async config loader that overlays DB-plane config on top of the
 * file/env config. Used by `gbrain` CLI's connectEngine() AFTER engine.connect()
 * so flags written via `gbrain config set` actually take effect. Unlike the
 * sync loadConfig(), this needs an engine handle to read the config table.
 *
 * Precedence: env > file > DB > defaults. Env stays the operator escape hatch;
 * file is the durable per-machine config; DB is the user-mutable runtime knob.
 *
 * Today only the v0.27.1 multimodal flags participate in DB-merge. Existing
 * fields (embedding_model, etc.) keep their file/env-only loading because they
 * size the schema and must be stable across engine connect.
 */
export async function loadConfigWithEngine(
  engine: { getConfig(key: string): Promise<string | null | undefined> },
  base?: GBrainConfig | null,
): Promise<GBrainConfig | null> {
  // Codex /ship finding #3: when there's no file config AND no env DB URL,
  // loadConfig() returns null and the DB merge would be skipped — env-only
  // installs (engine wired via direct SDK pass) wouldn't see DB-plane
  // overrides like `embedding_columns` / `search_embedding_column` set via
  // `gbrain config set`. Since we have a live engine here, synthesize a
  // minimal base config so the DB-plane merge still runs. The synthesized
  // config has no auth or model fields; DB-plane keys overlay correctly
  // and downstream callers either find them or fall through to defaults.
  // Also applies when callers pass an explicit null for `base`.
  const fileConfig: GBrainConfig =
    (base !== undefined ? base : loadConfig()) ??
    ({ engine: 'postgres' } as GBrainConfig);

  // DB-plane reads. Quiet failures — if the config table doesn't exist yet
  // (pre-v36 brain mid-migration), treat as null and let file/env defaults
  // win. The migration runner reads file/env directly anyway.
  async function dbBool(key: string): Promise<boolean | undefined> {
    try {
      const v = await engine.getConfig(key);
      if (v === undefined || v === null || v === '') return undefined;
      return v === 'true';
    } catch {
      return undefined;
    }
  }
  async function dbStr(key: string): Promise<string | undefined> {
    try {
      const v = await engine.getConfig(key);
      if (v === undefined || v === null || v === '') return undefined;
      return v;
    } catch {
      return undefined;
    }
  }

  const dbMultimodal = await dbBool('embedding_multimodal');
  const dbMultimodalModel = await dbStr('embedding_multimodal_model');
  const dbOcr = await dbBool('embedding_image_ocr');
  const dbOcrModel = await dbStr('embedding_image_ocr_model');
  // v0.36 (D7) — embedding-column registry merge. Stored as JSON string in
  // the config table. Parse + shape-check here; full registry validation
  // (regex on keys, type/dim/provider field shapes) runs in the resolver at
  // first use so a malformed DB row doesn't kill engine connect.
  const dbEmbeddingColumns = await dbStr('embedding_columns');
  const dbSearchEmbeddingColumn = await dbStr('search_embedding_column');

  // DB applies only when env did NOT win. Env presence is detected by the
  // sync loadConfig() already setting the field. For each flag, prefer the
  // existing fileConfig value when defined; otherwise fall through to DB.
  const merged: GBrainConfig = { ...fileConfig };
  if (merged.embedding_multimodal === undefined && dbMultimodal !== undefined) {
    merged.embedding_multimodal = dbMultimodal;
  }
  if (merged.embedding_multimodal_model === undefined && dbMultimodalModel !== undefined) {
    merged.embedding_multimodal_model = dbMultimodalModel;
  }
  if (merged.embedding_image_ocr === undefined && dbOcr !== undefined) {
    merged.embedding_image_ocr = dbOcr;
  }
  if (merged.embedding_image_ocr_model === undefined && dbOcrModel !== undefined) {
    merged.embedding_image_ocr_model = dbOcrModel;
  }
  if (merged.embedding_columns === undefined && dbEmbeddingColumns !== undefined) {
    try {
      const parsed = JSON.parse(dbEmbeddingColumns);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        merged.embedding_columns = parsed as Record<string, EmbeddingColumnConfig>;
      } else {
        console.warn('[gbrain] config: embedding_columns DB value is not a JSON object; ignoring');
      }
    } catch (err) {
      console.warn(`[gbrain] config: embedding_columns DB value is not valid JSON; ignoring (${(err as Error).message})`);
    }
  }
  if (merged.search_embedding_column === undefined && dbSearchEmbeddingColumn !== undefined) {
    merged.search_embedding_column = dbSearchEmbeddingColumn;
  }

  // v0.41 content-sanity DB-plane merge (D1: lint lifts to read these
  // when reachable). Per-key sparse-merge: env/file wins per individual
  // key; DB fills the gaps. The container object is constructed only if
  // at least one source provides a value, mirroring the env-merge logic
  // in loadConfig().
  async function dbInt(key: string): Promise<number | undefined> {
    const v = await dbStr(key);
    if (v === undefined) return undefined;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  const dbWarnBytes = await dbInt('content_sanity.bytes_warn');
  const dbBlockBytes = await dbInt('content_sanity.bytes_block');
  const dbJunkEnabled = await dbBool('content_sanity.junk_patterns_enabled');
  const dbSanityDisabled = await dbBool('content_sanity.disabled');

  const existingCS = merged.content_sanity ?? {};
  const mergedCS: NonNullable<GBrainConfig['content_sanity']> = { ...existingCS };
  if (mergedCS.bytes_warn === undefined && dbWarnBytes !== undefined) {
    mergedCS.bytes_warn = dbWarnBytes;
  }
  if (mergedCS.bytes_block === undefined && dbBlockBytes !== undefined) {
    mergedCS.bytes_block = dbBlockBytes;
  }
  if (mergedCS.junk_patterns_enabled === undefined && dbJunkEnabled !== undefined) {
    mergedCS.junk_patterns_enabled = dbJunkEnabled;
  }
  if (mergedCS.disabled === undefined && dbSanityDisabled !== undefined) {
    mergedCS.disabled = dbSanityDisabled;
  }
  if (Object.keys(mergedCS).length > 0) {
    merged.content_sanity = mergedCS;
  }

  return merged;
}

/**
 * v0.37 (D6): canonical list of known config keys for `gbrain config set`
 * validation. Includes both the static GBrainConfig fields (file plane)
 * and well-known DB-plane keys.
 *
 * This is NOT a runtime allow-list applied to reads — gateway/reader code
 * still tolerates extra keys. It's the suggestion source for "did you mean"
 * Levenshtein on `set`. Missing keys can be passed through with `--force`.
 *
 * When adding a new persistent config key:
 *   1. Add it to the GBrainConfig interface (if file-plane) OR document it
 *      below (if DB-plane).
 *   2. Add the canonical name to this list so `gbrain config set` accepts it
 *      without `--force`.
 */
export const KNOWN_CONFIG_KEYS: readonly string[] = [
  // File-plane (GBrainConfig static fields)
  'engine',
  'database_url',
  'database_path',
  'openai_api_key',
  'anthropic_api_key',
  'embedding_model',
  'embedding_dimensions',
  'embedding_disabled',
  'expansion_model',
  'chat_model',
  'chat_fallback_chain',
  'provider_base_urls',
  'storage',
  'eval',
  'eval.capture',
  'eval.scrub_pii',
  'embedding_multimodal',
  'embedding_multimodal_model',
  'embedding_image_ocr',
  'embedding_image_ocr_model',
  'embedding_columns',
  'search_embedding_column',
  'remote_mcp',
  'sync',
  'sync.repo_path',
  'sync.last_commit',
  // DB-plane (v0.32.3 search modes + related)
  'search.mode',
  'search.cache.enabled',
  'search.cache.similarity_threshold',
  'search.cache.ttl_seconds',
  'search.token_budget',
  'search.expansion',
  'search.intent_weighting',
  'search.limit_default',
  'search.mode_upgrade_notice_shown',
  'search.unified_multimodal',
  'search.unified_multimodal_only',
  'search.cross_modal.llm_intent',
  'search.image_query.max_bytes',
  'search.reranker.enabled',
  'search.track_retrieval',
  // Models tier system (v0.31.12)
  'models.default',
  'models.tier.utility',
  'models.tier.reasoning',
  'models.tier.deep',
  'models.tier.subagent',
  'models.aliases',
  'models.dream.synthesize',
  'models.dream.patterns',
  'models.dream.synthesize_verdict',
  'models.drift',
  'models.auto_think',
  'models.think',
  'models.subagent',
  'models.expansion',
  'models.chat',
  'models.eval.longmemeval',
  'facts.extraction_model',
  // Dream cycle config
  'dream.synthesize.session_corpus_dir',
  'dream.synthesize.meeting_transcripts_dir',
  'dream.synthesize.last_completion_ts',
  'dream.synthesize.verdict_model',
  'dream.synthesize.max_prompt_tokens',
  'dream.synthesize.max_chunks_per_transcript',
  'dream.patterns.lookback_days',
  'dream.patterns.min_evidence',
  // Emotional weight (v0.29)
  'emotional_weight.high_tags',
  'emotional_weight.user_holder',
  // Cycle phase config
  'cycle.grade_takes.write_gstack_learnings',
  // Content sanity (v0.41)
  'content_sanity.bytes_warn',
  'content_sanity.bytes_block',
  'content_sanity.junk_patterns_enabled',
  'content_sanity.disabled',
  // Misc
  'artifacts_sync_mode',
  'cross_project_learnings',
];

/**
 * v0.37 (D6): well-known prefix patterns for DB-plane keys that have
 * unbounded sub-keys. Used as a softer gate before falling back to
 * Levenshtein suggestion in `gbrain config set`.
 */
export const KNOWN_CONFIG_KEY_PREFIXES: readonly string[] = [
  'search.',           // search.* (mode, cache.*, etc.)
  'models.',           // models.* (tier, aliases, per-task)
  'dream.',            // dream.synthesize.*, dream.patterns.*
  'cycle.',            // cycle.<phase>.*
  'embedding_columns.', // per-column overrides
  'provider_base_urls.', // per-provider base URL overrides
  'content_sanity.',    // v0.41 content-sanity tunables
];

export function saveConfig(config: GBrainConfig): void {
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(getConfigPath(), 0o600);
  } catch {
    // chmod may fail on some platforms
  }
  // v0.35.8.0: ensure the per-home `.gitignore` exists on every config-write
  // path. Cheap, idempotent, doesn't clobber user edits. Catches the case
  // where `~/.gbrain/` lives inside a git worktree (Conductor + gstack
  // workspaces hit this) so `git add` doesn't accidentally stage the brain.
  // The doctor check `home_dir_in_worktree` surfaces vectors this can't
  // close (already-tracked files, screenshots, backups, `git add -f`).
  ensureGitignore();
}

/**
 * Idempotently lay down `~/.gbrain/.gitignore` containing the single line `*`.
 * Honors GBRAIN_HOME via `configDir()`. Best-effort: errors are logged to
 * stderr and never block the caller. Never clobbers a `.gitignore` whose
 * content the user has customized.
 *
 * Called from:
 *   - `saveConfig()` so any config-writing path lays it down.
 *   - `gbrain post-upgrade` so existing users get it on next upgrade.
 *
 * What this DOES cover: a casual `git add ~/.gbrain` from inside an enclosing
 * worktree — the directory-local `.gitignore` blocks everything below it.
 *
 * What this does NOT cover (the CHANGELOG names these honestly):
 *   - Files already tracked before the .gitignore landed (no remediation here).
 *   - Screenshots, sync folders (Dropbox/iCloud), Time Machine backups.
 *   - `git add -f ~/.gbrain` (deliberate force-add bypasses .gitignore).
 *   - Out-of-band copy operations (rsync, cp -r, scp).
 *
 * The doctor check `home_dir_in_worktree` surfaces these vectors at audit
 * time so the user can act on them.
 */
export function ensureGitignore(): void {
  try {
    const dir = configDir();
    const file = join(dir, '.gitignore');
    mkdirSync(dir, { recursive: true });
    if (existsSync(file)) {
      // Don't clobber user customization. Only write when the file is missing
      // OR when its content is empty (zero-byte placeholder).
      try {
        const existing = readFileSync(file, 'utf-8');
        if (existing.trim().length > 0) return;
      } catch {
        // Read failed but file exists — leave it alone to be safe.
        return;
      }
    }
    writeFileSync(file, '*\n', { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* platform-specific */ }
  } catch (e) {
    // Best-effort: log to stderr, never block the caller.
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[gbrain] ensureGitignore failed (${msg}); continuing\n`);
  }
}

export function toEngineConfig(config: GBrainConfig): EngineConfig {
  return {
    engine: config.engine,
    database_url: config.database_url,
    database_path: config.database_path,
  };
}

export function configDir(): string {
  // Allow override for tests, Docker, and multi-tenant deployments.
  // GBRAIN_HOME is a parent dir; we always append '.gbrain' ourselves so
  // setting GBRAIN_HOME=/tmp/x yields configDir() === '/tmp/x/.gbrain'.
  // Validates the override: must be absolute, no '..' segments.
  const override = process.env.GBRAIN_HOME;
  if (override && override.trim()) {
    const trimmed = override.trim();
    if (!isAbsolute(trimmed)) {
      throw new Error(`GBRAIN_HOME must be an absolute path; got: ${trimmed}`);
    }
    if (trimmed.split(/[\\/]/).includes('..')) {
      throw new Error(`GBRAIN_HOME must not contain '..' segments; got: ${trimmed}`);
    }
    return join(trimmed, '.gbrain');
  }
  return join(homedir(), '.gbrain');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

/**
 * Sugar for joining paths under the active gbrain home. Use this anywhere you
 * would otherwise write `join(homedir(), '.gbrain', ...rest)`. Honors
 * GBRAIN_HOME, validates input, and centralizes the convention so future
 * audits stay simple.
 */
export function gbrainPath(...segments: string[]): string {
  return join(configDir(), ...segments);
}

/**
 * Introspect where the active DB URL would come from if we tried to connect.
 * Never throws, never connects. Env vars take precedence (matches loadConfig).
 */
export function getDbUrlSource(): DbUrlSource {
  if (process.env.GBRAIN_DATABASE_URL) return 'env:GBRAIN_DATABASE_URL';
  if (process.env.DATABASE_URL) return 'env:DATABASE_URL';
  if (!existsSync(configPath())) return null;
  try {
    const raw = readFileSync(configPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<GBrainConfig>;
    if (parsed.database_url) return 'config-file';
    if (parsed.database_path) return 'config-file-path';
    return null;
  } catch {
    // Config file exists but is unreadable/malformed — treat as null source.
    return null;
  }
}
