import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, renameSync } from 'fs';
import { isAbsolute, join } from 'path';
import { homedir } from 'os';
import type { EngineConfig, EmbeddingColumnConfig } from './types.ts';
import { applyDbPlaneReadSideMerge, type DbPlaneEngineReader } from './config-db-merge.ts';
import { loadConfigSnapshot } from './config-snapshot.ts';
import { loadGbrainEnvFile } from './gbrain-env-file.ts';
import { dotenvValuesForKey } from './env-trust.ts';
import { REMOTE_PRIVATE_PAGES_KEY } from './search/private-visibility.ts';

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
  /** File-plane hook-lane keys (read by engine-free hook/push children).
   * `gbrain config set` routes these two dotted keys here, not to the DB. */
  push?: { allow_unverified_remote?: boolean };
  hooks?: { stop_push_debounce_min?: number | string };
  /** Ambient-writeback MIRROR of the DB-plane `memory.*` keys — `gbrain
   * config set memory.*` dual-writes both planes so the engine-free Stop-hook
   * child and the stdio boot resolve see the same truth the serve does. The
   * DB plane stays authoritative (the serve-side harvest gate re-checks it).
   * Resolved by src/core/facts/writeback-config.ts. */
  /** Declared brain audience MIRROR (WP8; DB plane authoritative like
   * `memory.*`): the engine-free bootstrap-harness lane gates its
   * ambient-writeback enable-nudge on it — a shared-declared brain is never
   * nudged. Written by `gbrain config set brain.audience personal|shared`. */
  brain?: { audience?: string };
  memory?: {
    auto_writeback?: string;
    auto_writeback_transient_ttl?: string;
    /** Visibility POSTURE cache stamped by `config set memory.*` (which has
     * the engine to resolve the DB-plane facts.default_visibility) so the
     * engine-free bootstrap-harness renderer can embed it. Doctor's
     * block-drift check catches staleness against DB truth. */
    visibility_posture?: string;
  };
  /**
   * Third-party integration gates, file-plane (read by engine-free hook
   * children). `integrations.memorable.enabled` gates the optional
   * session-end relay to a locally-installed `memorable` CLI — absent or
   * anything other than literal `true` means OFF (fail-closed). The boolean
   * alone is NOT sufficient: the gate also requires the gbrain-authored
   * consent stamp (`~/.gbrain/integrations/hooks/memorable-consent.json`,
   * written only by `gbrain config set`'s disclosure flow — deliberately
   * outside this file, which the external CLI rewrites). See
   * memorableGateAllowed in core/context/hook-heartbeat.ts.
   */
  integrations?: { memorable?: { enabled?: boolean } };
  /** Monthly backup-coverage check. File-plane for engine-free hook children. */
  backup?: { check_enabled?: boolean | string; check_interval_days?: number | string };
  /** #5232: CLI write wait in ms (file plane; persistence/write-wait.ts). */
  persistence?: { write_wait_ms?: number | string };
  migrate?: { graduation?: boolean }; // `migrate.graduation false`: legacy copier instead of graduation (file plane, read pre-connect)
  /** A4 user preapprovals (file plane only; set by the trusted local CLI; read by core/consent.ts). */
  consent?: { preapprove?: { paid?: { max_usd_per_run?: number }; persistent_install?: boolean } };
  database_url?: string;
  database_path?: string;
  openai_api_key?: string;
  anthropic_api_key?: string;
  /**
   * OpenRouter API key. File-plane slot so `gbrain config set
   * openrouter_api_key X` (or config.json) reaches the openrouter recipe:
   * file plane → loadConfig env merge → buildGatewayConfig env dict → recipe
   * reads OPENROUTER_API_KEY.
   */
  openrouter_api_key?: string;

  voyage_api_key?: string;
  /**
   * Alibaba DashScope API key (#3500). File-plane slot so config.json's
   * `dashscope_api_key` reaches the dashscope / dashscope-rerank recipes:
   * file plane → buildGatewayConfig env dict → recipe reads
   * DASHSCOPE_API_KEY. Same fold pattern (and same DB-plane caveat) as
   * voyage_api_key above.
   */
  dashscope_api_key?: string;
  deepseek_api_key?: string;
  /**
   * LiteLLM proxy API key. File-plane slot folded into the gateway env as
   * LITELLM_API_KEY (optional in the litellm recipe — proxies may run
   * unauthenticated locally). Closed alongside litellm's chat touchpoint
   * (v0.42.61.0): once litellm became a full chat provider, daemon/launchd/
   * MCP contexts hit the same config-plane gap voyage did (#2662). Same
   * fold pattern (and same DB-plane caveat) as voyage_api_key above.
   */
  litellm_api_key?: string;
  /**
   * Together AI API key. File-plane slot folded into the gateway env as
   * TOGETHER_API_KEY (required by the together recipe). Same fold pattern
   * (and same DB-plane caveat) as voyage_api_key above.
   */
  together_api_key?: string;
  /**
   * Google Gemini API key (#3500). File-plane slot folded into the gateway
   * env as GOOGLE_GENERATIVE_AI_API_KEY (the name the google recipe reads).
   * buildGatewayConfig also accepts process-env GEMINI_API_KEY — the name
   * Google's own docs/SDKs use — as an alias for
   * GOOGLE_GENERATIVE_AI_API_KEY. Same fold pattern (and same DB-plane
   * caveat) as voyage_api_key above.
   */
  google_api_key?: string;
  /**
   * Azure OpenAI API key (#4031). File-plane slot folded into the gateway env
   * as AZURE_OPENAI_API_KEY (the name the azure-openai recipe reads). Same
   * fold pattern (and same DB-plane caveat) as voyage_api_key above. Key-based
   * auth alternative to the Entra flow below.
   */
  azure_openai_api_key?: string;
  /** Azure OpenAI (keyless/Entra). Non-secret endpoint/deployment + Entra opt-in;
   * bearer token is minted at request time via `az` — no secret stored here. */
  azure_openai_endpoint?: string;
  azure_openai_deployment?: string;
  azure_openai_use_entra?: string;

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
   * Optional chat fallback chain for `chatWithFallback()` (v0.27+): tried in
   * order when a chat call fails or refuses. Each entry is a "provider:modelId"
   * string. Judge, critic and eval call sites pin their model (allowFallback).
   */
  chat_fallback_chain?: string[];
  /** `false`: the chain still covers errors but never forwards a refused request. Default true (env, file, DB). */
  chat_fallback_on_refusal?: boolean;
  /** Optional base URL overrides for openai-compatible providers (keyed by recipe id). */
  provider_base_urls?: Record<string, string>;
  /** Optional chat request providerOptions overrides keyed by recipe id or "recipe:modelId". */
  provider_chat_options?: Record<string, Record<string, unknown>>;
  /**
   * MEMORY_VERBS v1 (Cathedral 1): default MCP tool surface for `gbrain serve`.
   * 'verbs' = exactly the 7 protocol verbs (the quickstart surface);
   * 'starter' (WP4) = the ~20-op daily-driver set (STARTER_OPS in
   * src/mcp/surface.ts); 'full' (default) = every operation. The `--surface`
   * flag overrides per-run. On the OAuth HTTP transport this resolves the
   * server CEILING (D2): per-client row surfaces can narrow below it but
   * never widen past it.
   */
  mcp_surface?: 'verbs' | 'starter' | 'full';
  /**
   * MEMORY_VERBS v1 [D6C]: ISO timestamp stamped by `gbrain init` so
   * `gbrain protocol stats` can derive real TTHW (install → first verb call).
   */
  protocol_installed_at?: string;
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
       * Run-level cap (USD) over every paid call of one probe run (LongMemEval
       * and judges). Default 5; a set value is a user cap (unpriced → no_pricing).
       */
      max_usd?: number;
    };
    /**
     * v0.41.16.0 — nightly conversation-parser probe. Per D10: default ON
     * for `search.mode=tokenmax` brains, opt-in for conservative/balanced.
     * ~$0.05/night with the committed fixtures × Haiku polish. Gated
     * INSIDE the autopilot tick body, like nightly_quality_probe.
     */
    conversation_parser_probe?: {
      /** Enable for non-tokenmax modes. Defaults to false. */
      enabled?: boolean;
    };
    /**
     * v0.42.x (#1685 GAP D) — extract_atoms backlog auto-drain. Default ON so a
     * pack-gated silent backlog never piles up unseen; daily-spend-capped so the
     * Haiku spend stays bounded. Read via the DB plane (`engine.getConfig`) at
     * each autopilot tick. Disable with `gbrain config set autopilot.auto_drain.enabled false`.
     */
    auto_drain?: {
      /** Master switch. Default true. */
      enabled?: boolean;
      /** Per-drain wallclock budget in seconds. Default 120. */
      window_seconds?: number;
      /** Backlog must exceed this to trigger a drain. Default 25. */
      threshold?: number;
      /** Daily spend cap (USD); bounds drains/day = floor(cap / ~$0.30). Default 2.0. */
      max_usd_per_day?: number;
    };
    /**
     * v0.42 — extract frontmatter (`sources:`/`related:` etc.) link edges too, not
     * just body links, on every extraction path: the incremental cycle, sync's
     * inline extract, the GitHub/Google source inline extracts, the extract_stale
     * minion, `gbrain maintain`, and a flagless stale extract sweep
     * (src/core/extract-frontmatter.ts resolves it once for all of them).
     * Keeps externally-edited YAML edges fresh without a full rescan. Default
     * false (body links only). Read via the file/DB plane, file wins. Enable with
     * `gbrain config set autopilot.incremental_extract_include_frontmatter <bool>`.
     */
    incremental_extract_include_frontmatter?: boolean;
  };
  eval?: {
    /** false disables capture entirely. Defaults to true. */
    capture?: boolean;
    /** false disables PII scrubbing before insert. Defaults to true. */
    scrub_pii?: boolean;
  };
  /**
   * Adaptive return-sizing (search/return-policy.ts, default OFF). DB-plane
   * `search.adaptive_return*` rows nest here via loadConfigWithEngine (file > DB).
   */
  search?: {
    adaptive_return?: boolean;
    adaptive_return_entity_max?: number;
    adaptive_return_other_max?: number;
    adaptive_return_min_keep?: number;
    /** #5824 rollback switch (search/vector-legacy-guard.ts); file > DB, env wins over both. */
    vector_legacy_guard?: boolean;
    /** #6132 pgvector iterative scan mode (search/hnsw-iterative-scan.ts); file > DB, env wins over both. */
    hnsw_iterative_scan?: string;
    /** #5989 CJK keyword arm deadline in ms (search/cjk-keyword-deadline.ts); file > DB. */
    cjk_keyword_deadline_ms?: number;
  };

  /**
   * v0.42 — self-upgrade settings (file plane; read on the hot path before any
   * DB connect, so it must live here, not the DB plane). `mode` is the only
   * knob most users touch: `notify` (default — emit a marker + 4-option prompt),
   * `auto` (silent quiet-hours/idle upgrade; opt-in), `off` (never check).
   * The rest are state the self-upgrade machinery manages.
   */
  self_upgrade?: {
    mode?: 'auto' | 'notify' | 'off';
    /** Set true once the upgrade-time consent prompt has been shown. */
    mode_prompted?: boolean;
    /** Quiet-hours window for the autopilot silent channel. */
    quiet_hours?: { start?: number; end?: number; tz?: string };
    /** Versions that failed a prior auto-upgrade; never auto-retried. */
    failed_versions?: string[];
    /** Pre-swap breadcrumb so a crash-on-launch version is attributable. */
    attempting_version?: string;
    /** Epoch ms of the last auto-channel check (24h throttle). */
    last_check_ts?: number;
    last_applied_version?: string;
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

  /**
   * v0.42 (#1981) — Retrieval Reflex. The context engine's deterministic
   * per-turn entity-pointer injection. Default ON (absent key = enabled).
   *
   * IMPORTANT: this is a FILE-PLANE / env gate only. The context engine reads
   * it via the synchronous `loadConfig()` during `assemble()`, which never
   * touches the DB. So `gbrain config set retrieval_reflex false` (DB plane)
   * does NOT disable the reflex — set it in `~/.gbrain/config.json` or via
   * `GBRAIN_RETRIEVAL_REFLEX=false`.
   */
  retrieval_reflex?: boolean;
  /** Max pointers injected per turn (default 3). File-plane only. */
  retrieval_reflex_max_pointers?: number;
  /**
   * v0.43 (#2095) — how many recent turns the reflex extracts entities from
   * (default 4). 1 reproduces the legacy current-turn-only behavior (and the
   * legacy slug+title suppression). File-plane / env
   * (GBRAIN_RETRIEVAL_REFLEX_WINDOW_TURNS) only — same plane as the other
   * reflex knobs.
   */
  retrieval_reflex_window_turns?: number;
  /**
   * v0.46.15 (identity wave) — kill switch for the reflex's lexical recall
   * arms (lowercase weak-candidate alias arm + surname arm). Default ON
   * (absent = enabled); `false` reproduces pre-wave resolution exactly.
   * File-plane / env (GBRAIN_RETRIEVAL_REFLEX_LEXICAL_ARMS) only — same
   * plane as the other reflex knobs; a false-fire regression in production
   * reverts on the next turn with a config edit, no redeploy.
   */
  retrieval_reflex_lexical_arms?: boolean;
  /**
   * 2026-08 fix wave — kill switch for the reflex's volunteer arm (Arm 2:
   * confidence-gated volunteered pages fused after the pointer budget, parity
   * with the claude-code turn-context lane). Default ON (absent = enabled).
   * File-plane / env (GBRAIN_RETRIEVAL_REFLEX_VOLUNTEER) only — same plane as
   * the other reflex knobs; the incident lever is the env var.
   */
  retrieval_reflex_volunteer?: boolean;
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
    /** #4702 — built-in junk-pattern names to skip individually (e.g.
     *  `['access_denied']` for a brain whose pages quote that error rather
     *  than being it). Finer than `junk_patterns_enabled: false` (the
     *  coarser knob, which drops EVERY pattern) and than the `disabled`
     *  kill-switch (which also drops the load-bearing size gates). Unknown
     *  names are ignored. DB plane accepts a JSON array or a comma-
     *  separated list: `gbrain config set content_sanity.disabled_patterns
     *  access_denied,error_title`. */
    disabled_patterns?: string[];
    /** Master kill-switch for all sanity checks. When true, ingest emits
     *  loud stderr per page but lets everything through. Default: false.
     *  Env override: `GBRAIN_NO_SANITY=1` flips to true. */
    disabled?: boolean;
    /** Disposition for high-confidence junk (Cloudflare/CAPTCHA pattern or
     *  operator literal). `quarantine` (default) = page lands hidden +
     *  reviewable; `reject` = hard-block (throw → sync-failure). Issue #1699.
     *  No env override (a destructive flip belongs in explicit config). */
    junk_disposition?: 'quarantine' | 'reject';
    /** Max markup:total ratio before the fuzzy markup-heavy FLAG fires
     *  (page stays searchable, agent warned). Default: 0.85. Env override:
     *  `GBRAIN_MAX_MARKUP_RATIO`. */
    max_markup_ratio?: number;
    /** Master switch for the prose/markup pass. Default: true. When false,
     *  no markup-heavy flagging happens (patterns + oversize still apply). */
    prose_check_enabled?: boolean;
  };

  /**
   * v0.41.2.1 — dream cycle config (synthesize + patterns phases).
   * Read-precedence per key: file > DB > defaults. There are no
   * `GBRAIN_DREAM_*` env vars; do not add an env layer without first
   * extending `loadConfig()` to read them.
   *
   * Existing consumers (synthesize.ts, patterns.ts) read these keys
   * directly via `engine.getConfig()`, so they already see DB-plane
   * values. The structured shape here exists so consumers that read
   * the merged config object (e.g. extract-atoms.ts) see the values
   * uniformly without per-call-site `engine.getConfig()` fallbacks.
   *
   * Closes PR #1416's "silent dream.* config misses on DB-plane writes"
   * for the merged-config code path.
   */
  dream?: {
    synthesize?: {
      session_corpus_dir?: string;
      meeting_transcripts_dir?: string;
      verdict_model?: string;
      max_prompt_tokens?: number;
      max_chunks_per_transcript?: number;
      subagent_timeout_ms?: number;
      subagent_wait_timeout_ms?: number;
    };
    patterns?: {
      lookback_days?: number;
      min_evidence?: number;
    };
  };

  /**
   * #2119-class read-side (also #2137/#4297) — flat map of DB-plane `cycle.*`
   * knobs, keyed by the path UNDER the `cycle.` prefix (e.g.
   * `cycle.extract_atoms.budget_usd` → `cycle['extract_atoms.budget_usd']`),
   * values raw strings (each consumer owns its parse, as with
   * `engine.getConfig()`). Populated by `loadConfigWithEngine()`; per-leaf
   * precedence file > DB (no env layer). See src/core/config-db-merge.ts.
   */
  cycle?: Record<string, string>;

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

  /**
   * PR1 — MCP skill-catalog publishing. Lets a thin MCP client (Codex desktop,
   * Claude Code, Perplexity) discover and follow this agent repo's skills over
   * `gbrain serve`. See `src/core/skill-catalog.ts` for the trust-boundary memo.
   */
  mcp?: {
    /**
     * #4748 — deployment-specific identity and routing guidance appended to
     * the canonical operating contract in the MCP initialize response (all
     * three transports). Distinguishes brains sharing one tool catalog.
     * `GBRAIN_MCP_INSTRUCTIONS` env overrides this slot; blank/absent keeps
     * the initialize response byte-identical to the canonical contract.
     */
    instructions?: string;
    /**
     * Gate for `list_skills` / `get_skill` over a REMOTE transport. Runtime
     * default is OFF (absent key → OFF) so an upgrade never silently grants
     * existing read tokens host-skill read. `gbrain init` writes `true` for new
     * installs; the upgrade migration prompts existing owners to enable it.
     * Local CLI callers (`ctx.remote === false`) bypass the gate entirely.
     */
    publish_skills?: boolean;
    /**
     * Gate for the `advisor` op over a REMOTE transport (#2180). Separate from
     * `publish_skills` because the advisor exposes operational diagnostics
     * (version drift, stalled jobs, embedding-key presence), not prose skills.
     * Default OFF; local CLI callers bypass. The MCP advisor is read-only.
     */
    publish_advisor?: boolean;
    /**
     * Explicit skills-dir override. Wins over autodetect — makes which skills
     * get published deterministic across laptop / daemon / container launches.
     * When unset, the ops autodetect (remote callers exclude the install-path
     * tier so a hosted gbrain never serves its own bundled dev skills).
     */
    skills_dir?: string;
    /**
     * WP3 — unknown tool-call argument posture for MCP dispatch.
     *   'warn' (default / absent): unknown params are accepted; each call
     *     collects `_meta.warnings` + a model-visible notice block, and the
     *     request logs as 'success_with_warnings'.
     *   'reject': unknown params return `invalid_params` (with a
     *     did-you-mean suggestion), and tool schemas are emitted with
     *     `additionalProperties: false`.
     * Dual-plane: DB plane (`gbrain config set mcp.strict_params ...`) wins
     * over this file slot. See src/mcp/validate-params.ts.
     */
    strict_params?: 'warn' | 'reject';
    /**
     * WP4 (D2 / plan OQ1) — default surface for OAuth clients whose
     * `oauth_clients.surface` row value is NULL. oauth_clients carries no
     * DCR-origin marker, so this applies to ALL null-surface clients (not
     * just dynamically-registered ones); operators pre-seed important
     * clients with `gbrain auth rescope-client <id> --surface full`.
     * Unset (default) = null-surface clients get the server ceiling —
     * pre-WP4 behavior, existing clients untouched. Dual-plane: the DB
     * plane (`gbrain config set mcp.default_surface_dcr starter`) wins
     * over this file slot. Always bounded by the server ceiling (D2).
     */
    default_surface_dcr?: 'verbs' | 'starter' | 'full';
    /** Tools listed to agents (callable set unchanged; request_tools reaches the rest). Dual-plane, DB > file. */
    advertised_surface?: 'verbs' | 'starter' | 'full';
    /** Search/query row shape for remote MCP callers: 'lean' (default) | 'full'. Dual-plane, DB > file. */
    result_rows?: 'lean' | 'full';
    /** Stdio `request_tools {surface}` widens the session's tool surface (default true). Dual-plane, DB > file. */
    allow_session_widen?: boolean | string;
  };
}

/**
 * True when this install is configured as a thin client of a remote
 * `gbrain serve --http`. Single source of truth for the "is this a
 * thin-client install?" check used by the CLI dispatch guard, doctor
 * branch, and remote subcommands.
 */
/**
 * The ONE robust negative parse for boolean env kill switches (2026-08 wave
 * DRY sweep — previously copy-pasted at four sites with cross-referencing
 * comments): case-insensitive false/0/off/no, so an operator typing FALSE or
 * off mid-incident never gets a silent no-op (adversarial F11). An env value
 * that is unset or empty is NOT "disabled" — callers gate on presence first.
 */
export function isEnvDisabled(value: string): boolean {
  return /^(false|0|off|no)$/i.test(value.trim());
}

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

/**
 * #427 guard — DATABASE_URL hijack via Bun's cwd .env auto-load.
 *
 * Bun merges `.env` files from the process cwd into process.env before any
 * user code runs, so running gbrain inside any checkout whose `.env` defines
 * DATABASE_URL (Next.js, Hono, Supabase, most web apps) would silently
 * retarget the brain at that app's database — `apply-migrations` could write
 * gbrain's schema into a production app database (the v0.42.8 report on #427).
 * The cwd-.env parser (`CWD_DOTENV_FILES`, `dotenvValuesForKey`) lives in
 * env-trust.ts beside the key-presence security quarantine; both symbols are
 * re-exported here so import sites never chase the move. This guard keeps
 * VALUE-match semantics: a DATABASE_URL equal to a cwd-.env assignment is
 * file-origin; a deliberate export that happens to EQUAL it would have chosen
 * the same database anyway, and GBRAIN_DATABASE_URL is never auto-ignored.
 */
export { CWD_DOTENV_FILES, dotenvValuesForKey } from './env-trust.ts';

let warnedCwdEnvDbUrlIgnored = false;

/**
 * The env-provided DB URL gbrain should honor, with the #427 guard applied:
 * a DATABASE_URL whose value matches an assignment in a cwd .env file is
 * treated as belonging to the project in cwd, not to gbrain, and ignored
 * with a one-time stderr notice. GBRAIN_DATABASE_URL is always honored.
 * `dir` is injectable for tests; callers use the default.
 */
export function effectiveEnvDatabaseUrl(dir: string = process.cwd()): string | undefined {
  if (process.env.GBRAIN_DATABASE_URL) return process.env.GBRAIN_DATABASE_URL;
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  if (dotenvValuesForKey('DATABASE_URL', dir).has(url)) {
    if (!warnedCwdEnvDbUrlIgnored) {
      warnedCwdEnvDbUrlIgnored = true;
      console.warn(
        '[config] Ignoring DATABASE_URL auto-loaded by Bun from a .env file in the current ' +
        'directory — it belongs to the project here, not to gbrain. Using the engine from ' +
        '~/.gbrain/config.json instead. To point gbrain at that database deliberately, set ' +
        'GBRAIN_DATABASE_URL.',
      );
    }
    return undefined;
  }
  return url;
}

/**
 * The #427 shadow predicate, single-homed: a bare DATABASE_URL exists in the
 * process env but the cwd-.env guard excluded it (and GBRAIN_DATABASE_URL is
 * unset) — the "init inside a web-app checkout" confusion shape. Consumers:
 * engine-status, db-repair, the CLI's no-config marker site.
 */
export function envShadowDetected(dir: string = process.cwd()): boolean {
  return (
    typeof process.env.DATABASE_URL === 'string' &&
    process.env.DATABASE_URL.length > 0 &&
    !process.env.GBRAIN_DATABASE_URL &&
    effectiveEnvDatabaseUrl(dir) === undefined
  );
}

export function loadConfig(): GBrainConfig | null {
  // #3893 (reimplemented from @y2688): fill process.env from the
  // operator-owned ~/.gbrain/.env BEFORE the env-over-file merge below, so
  // secrets can live outside config.json. Shell-exported env always wins
  // (the loader never overrides an existing var), and cwd .env files stay
  // untrusted (#427 guard above).
  loadGbrainEnvFile(getConfigDir);

  let fileConfig: GBrainConfig | null = null;
  try {
    const raw = readFileSync(getConfigPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    fileConfig = migrateLegacyEmbeddingConfig(parsed) as unknown as GBrainConfig;
  } catch { /* no config file */ }

  // Try env vars (cwd-.env-origin DATABASE_URL excluded — see #427 guard above)
  const dbUrl = effectiveEnvDatabaseUrl();

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
    ...(process.env.OPENROUTER_API_KEY ? { openrouter_api_key: process.env.OPENROUTER_API_KEY } : {}),
    ...(process.env.GBRAIN_EMBEDDING_MODEL ? { embedding_model: process.env.GBRAIN_EMBEDDING_MODEL } : {}),
    ...(process.env.GBRAIN_EMBEDDING_DIMENSIONS ? { embedding_dimensions: parseInt(process.env.GBRAIN_EMBEDDING_DIMENSIONS, 10) } : {}),
    ...(process.env.GBRAIN_EXPANSION_MODEL ? { expansion_model: process.env.GBRAIN_EXPANSION_MODEL } : {}),
    ...(process.env.GBRAIN_CHAT_MODEL ? { chat_model: process.env.GBRAIN_CHAT_MODEL } : {}),
    ...(process.env.GBRAIN_CHAT_FALLBACK_CHAIN
      ? { chat_fallback_chain: process.env.GBRAIN_CHAT_FALLBACK_CHAIN.split(',').map(s => s.trim()).filter(Boolean) }
      : {}),
    ...(process.env.GBRAIN_CHAT_FALLBACK_ON_REFUSAL?.trim()
      ? { chat_fallback_on_refusal: !isEnvDisabled(process.env.GBRAIN_CHAT_FALLBACK_ON_REFUSAL) }
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
    ...(process.env.GBRAIN_RETRIEVAL_REFLEX
      ? { retrieval_reflex: !(process.env.GBRAIN_RETRIEVAL_REFLEX === 'false' || process.env.GBRAIN_RETRIEVAL_REFLEX === '0') }
      : {}),
    ...(process.env.GBRAIN_RETRIEVAL_REFLEX_WINDOW_TURNS &&
      Number.isFinite(Number(process.env.GBRAIN_RETRIEVAL_REFLEX_WINDOW_TURNS))
      ? { retrieval_reflex_window_turns: Number(process.env.GBRAIN_RETRIEVAL_REFLEX_WINDOW_TURNS) }
      : {}),
    ...(process.env.GBRAIN_RETRIEVAL_REFLEX_LEXICAL_ARMS
      ? {
          // Incident escape hatch — shared isEnvDisabled parse (also used by
          // reflex.ts:lexicalArmsEnabled/volunteerEnabled).
          retrieval_reflex_lexical_arms: !isEnvDisabled(process.env.GBRAIN_RETRIEVAL_REFLEX_LEXICAL_ARMS),
        }
      : {}),
    ...(process.env.GBRAIN_RETRIEVAL_REFLEX_VOLUNTEER
      ? {
          retrieval_reflex_volunteer: !isEnvDisabled(process.env.GBRAIN_RETRIEVAL_REFLEX_VOLUNTEER),
        }
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
  if (process.env.GBRAIN_MAX_MARKUP_RATIO) {
    const n = parseFloat(process.env.GBRAIN_MAX_MARKUP_RATIO);
    if (Number.isFinite(n) && n > 0 && n <= 1) envContentSanity.max_markup_ratio = n;
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

// #2119 read-side merge list re-exported so callers keep one config surface.
export { DB_MERGED_PROVIDER_KEY_FIELDS } from './config-db-merge.ts';

/**
 * DB-plane rows for the vector/keyword scan knobs nested under `search` (file
 * plane wins): the #5824 legacy guard, the #6132 iterative scan mode and the
 * #5989 CJK keyword deadline.
 */
async function mergeSearchScanKnobs(
  mergedSearch: NonNullable<GBrainConfig['search']>,
  dbStr: (key: string) => Promise<string | undefined>,
  dbBoolStrict: (key: string) => Promise<boolean | undefined>,
): Promise<void> {
  const dbVectorLegacyGuard = await dbBoolStrict('search.vector_legacy_guard');
  if (mergedSearch.vector_legacy_guard === undefined && dbVectorLegacyGuard !== undefined) mergedSearch.vector_legacy_guard = dbVectorLegacyGuard;
  const dbHnswIterativeScan = await dbStr('search.hnsw_iterative_scan');
  if (mergedSearch.hnsw_iterative_scan === undefined && dbHnswIterativeScan !== undefined) mergedSearch.hnsw_iterative_scan = dbHnswIterativeScan;
  const dbCjkDeadline = Number(await dbStr('search.cjk_keyword_deadline_ms'));
  if (mergedSearch.cjk_keyword_deadline_ms === undefined && Number.isFinite(dbCjkDeadline) && dbCjkDeadline > 0) mergedSearch.cjk_keyword_deadline_ms = dbCjkDeadline;
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
 * Participating DB-plane keys: multimodal/OCR flags, provider_base_urls.*,
 * the embedding-column registry, content_sanity.*, dream.*, eval.*, and the
 * #2119-class read-side set (provider credentials, chat/expansion pins,
 * chat_fallback_chain, flat cycle.* — see src/core/config-db-merge.ts, which
 * also documents why embedding_model/dims must NEVER join any list, #4287).
 */
export async function loadConfigWithEngine(
  // DbPlaneEngineReader: { getConfig; listConfigKeys?; getAllConfig?;
  // executeRaw? } — the optional getAllConfig serves every read below from
  // one snapshot; the optional executeRaw lets the #2119 merge batch its
  // reads in one query when no snapshot is available.
  engine: DbPlaneEngineReader,
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

  // This function reads two dozen config keys. One key per round trip is free
  // on PGLite and is most of the wall clock on a hosted Postgres, so read the
  // whole table once and answer every key from that. See config-snapshot.ts.
  //
  // Quiet failure below is deliberate and unchanged: when the snapshot is
  // unavailable (a pre-v36 brain mid-migration, or an engine from outside this
  // repo) every read falls back to a per-key getConfig(), same as before.
  const snapshot = await loadConfigSnapshot(engine);

  function dbRaw(key: string): Promise<string | null | undefined> {
    if (snapshot) return Promise.resolve(snapshot[key]);
    return Promise.resolve(engine.getConfig(key));
  }
  async function dbBool(key: string): Promise<boolean | undefined> {
    try {
      const v = await dbRaw(key);
      if (v === undefined || v === null || v === '') return undefined;
      return v === 'true';
    } catch {
      return undefined;
    }
  }
  async function dbStr(key: string): Promise<string | undefined> {
    try {
      const v = await dbRaw(key);
      if (v === undefined || v === null || v === '') return undefined;
      return v;
    } catch {
      return undefined;
    }
  }
  async function dbPrefixMap(prefix: string): Promise<Record<string, string> | undefined> {
    let keys: string[];
    if (snapshot) {
      keys = Object.keys(snapshot);
    } else if (typeof engine.listConfigKeys === 'function') {
      try {
        keys = await engine.listConfigKeys(prefix);
      } catch {
        return undefined;
      }
    } else {
      return undefined;
    }

    const out: Record<string, string> = {};
    for (const key of keys.sort()) {
      if (!key.startsWith(prefix)) continue;
      const leaf = key.slice(prefix.length);
      if (!leaf) continue;
      const value = await dbStr(key);
      if (value !== undefined) out[leaf] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  const dbMultimodal = await dbBool('embedding_multimodal');
  const dbMultimodalModel = await dbStr('embedding_multimodal_model');
  const dbOcr = await dbBool('embedding_image_ocr');
  const dbOcrModel = await dbStr('embedding_image_ocr_model');
  const dbProviderBaseUrls = await dbPrefixMap('provider_base_urls.');
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
  if (dbProviderBaseUrls !== undefined) {
    const next = { ...(merged.provider_base_urls ?? {}) };
    for (const [providerId, baseUrl] of Object.entries(dbProviderBaseUrls)) {
      if (next[providerId] === undefined) next[providerId] = baseUrl;
    }
    if (Object.keys(next).length > 0) {
      merged.provider_base_urls = next;
    }
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
  async function dbNum(key: string): Promise<number | undefined> {
    const v = await dbStr(key);
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isNaN(n) ? undefined : n;
  }
  const dbWarnBytes = await dbInt('content_sanity.bytes_warn');
  const dbBlockBytes = await dbInt('content_sanity.bytes_block');
  const dbJunkEnabled = await dbBool('content_sanity.junk_patterns_enabled');
  const dbSanityDisabled = await dbBool('content_sanity.disabled');
  const dbJunkDisposition = await dbStr('content_sanity.junk_disposition');
  const dbMaxMarkupRatioStr = await dbStr('content_sanity.max_markup_ratio');
  const dbProseCheckEnabled = await dbBool('content_sanity.prose_check_enabled');
  // #4702: per-pattern opt-out. Accepts a JSON array ('["access_denied"]')
  // or a comma-separated list ('access_denied,error_title'); malformed JSON
  // falls back to the comma parse so a hand-typed value still lands.
  const dbDisabledPatternsStr = await dbStr('content_sanity.disabled_patterns');
  let dbDisabledPatterns: string[] | undefined;
  if (dbDisabledPatternsStr !== undefined) {
    const raw = dbDisabledPatternsStr.trim();
    if (raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          dbDisabledPatterns = parsed.filter((x): x is string => typeof x === 'string');
        }
      } catch { /* fall through to comma parse */ }
    }
    if (dbDisabledPatterns === undefined) {
      dbDisabledPatterns = raw.split(',').map(s => s.trim()).filter(Boolean);
    }
  }

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
  if (
    mergedCS.junk_disposition === undefined &&
    (dbJunkDisposition === 'quarantine' || dbJunkDisposition === 'reject')
  ) {
    mergedCS.junk_disposition = dbJunkDisposition;
  }
  if (mergedCS.max_markup_ratio === undefined && dbMaxMarkupRatioStr !== undefined) {
    const n = parseFloat(dbMaxMarkupRatioStr);
    if (Number.isFinite(n) && n > 0 && n <= 1) mergedCS.max_markup_ratio = n;
  }
  if (mergedCS.prose_check_enabled === undefined && dbProseCheckEnabled !== undefined) {
    mergedCS.prose_check_enabled = dbProseCheckEnabled;
  }
  if (mergedCS.disabled_patterns === undefined && dbDisabledPatterns !== undefined) {
    mergedCS.disabled_patterns = dbDisabledPatterns;
  }
  if (Object.keys(mergedCS).length > 0) {
    merged.content_sanity = mergedCS;
  }

  // v0.41.2.1 — dream.* DB-plane merge. Precedence is file > DB > defaults
  // per key (NO env layer; see GBrainConfig.dream JSDoc). Without this,
  // `extract-atoms.ts` and any other consumer that reads the merged config
  // (vs calling `engine.getConfig()` directly) silently misses dream.*
  // config set via `gbrain config set`.
  const dbSessionCorpusDir = await dbStr('dream.synthesize.session_corpus_dir');
  const dbMeetingTranscriptsDir = await dbStr('dream.synthesize.meeting_transcripts_dir');
  const dbVerdictModel = await dbStr('dream.synthesize.verdict_model');
  const dbMaxPromptTokens = await dbInt('dream.synthesize.max_prompt_tokens');
  const dbMaxChunksPerTranscript = await dbInt('dream.synthesize.max_chunks_per_transcript');
  const dbSubagentTimeoutMs = await dbNum('dream.synthesize.subagent_timeout_ms');
  const dbSubagentWaitTimeoutMs = await dbNum('dream.synthesize.subagent_wait_timeout_ms');
  const dbLookbackDays = await dbInt('dream.patterns.lookback_days');
  const dbMinEvidence = await dbInt('dream.patterns.min_evidence');

  const existingDream = merged.dream ?? {};
  const existingSynth = existingDream.synthesize ?? {};
  const existingPatterns = existingDream.patterns ?? {};
  const mergedSynth: NonNullable<NonNullable<GBrainConfig['dream']>['synthesize']> = { ...existingSynth };
  const mergedPatterns: NonNullable<NonNullable<GBrainConfig['dream']>['patterns']> = { ...existingPatterns };

  if (mergedSynth.session_corpus_dir === undefined && dbSessionCorpusDir !== undefined) {
    mergedSynth.session_corpus_dir = dbSessionCorpusDir;
  }
  if (mergedSynth.meeting_transcripts_dir === undefined && dbMeetingTranscriptsDir !== undefined) {
    mergedSynth.meeting_transcripts_dir = dbMeetingTranscriptsDir;
  }
  if (mergedSynth.verdict_model === undefined && dbVerdictModel !== undefined) {
    mergedSynth.verdict_model = dbVerdictModel;
  }
  if (mergedSynth.max_prompt_tokens === undefined && dbMaxPromptTokens !== undefined) {
    mergedSynth.max_prompt_tokens = dbMaxPromptTokens;
  }
  if (mergedSynth.max_chunks_per_transcript === undefined && dbMaxChunksPerTranscript !== undefined) {
    mergedSynth.max_chunks_per_transcript = dbMaxChunksPerTranscript;
  }
  if (mergedSynth.subagent_timeout_ms === undefined && dbSubagentTimeoutMs !== undefined) {
    mergedSynth.subagent_timeout_ms = dbSubagentTimeoutMs;
  }
  if (mergedSynth.subagent_wait_timeout_ms === undefined && dbSubagentWaitTimeoutMs !== undefined) {
    mergedSynth.subagent_wait_timeout_ms = dbSubagentWaitTimeoutMs;
  }
  if (mergedPatterns.lookback_days === undefined && dbLookbackDays !== undefined) {
    mergedPatterns.lookback_days = dbLookbackDays;
  }
  if (mergedPatterns.min_evidence === undefined && dbMinEvidence !== undefined) {
    mergedPatterns.min_evidence = dbMinEvidence;
  }

  // Only construct the dream container when at least one leaf was populated
  // — mirrors the content_sanity pattern so empty brains keep `cfg.dream`
  // undefined.
  if (Object.keys(mergedSynth).length > 0 || Object.keys(mergedPatterns).length > 0) {
    const mergedDream: NonNullable<GBrainConfig['dream']> = {};
    if (Object.keys(mergedSynth).length > 0) mergedDream.synthesize = mergedSynth;
    if (Object.keys(mergedPatterns).length > 0) mergedDream.patterns = mergedPatterns;
    merged.dream = mergedDream;
  }

  // #1475 — eval.* DB-plane merge. Both keys are in KNOWN_CONFIG_KEYS, so
  // `gbrain config set eval.capture true` is accepted and stored, and
  // `gbrain config get` reads it back (it queries engine.getConfig directly
  // and prints `source: db plane`). But the runtime gates read the MERGED
  // config — isEvalCaptureEnabled/isEvalScrubEnabled take `ctx.config` — so
  // without a merge branch here the write was accepted, echoed back, and had
  // no effect: capture stayed off unless GBRAIN_CONTRIBUTOR_MODE=1 was also
  // exported, which is what the config was supposed to make unnecessary.
  //
  // Both directions matter. `false` is not "unset": eval.capture=false is the
  // documented opt-out for a brain that has CONTRIBUTOR_MODE exported, and
  // eval.scrub_pii=false is an explicit privacy decision. dbBool already
  // distinguishes them ('' / null / undefined → undefined).
  // Strict, not `dbBool`. `dbBool` maps every non-empty value other than the
  // exact string 'true' to FALSE, and `config set` stores whatever it is given
  // — so `gbrain config set eval.scrub_pii TRUE` (or `1`, or a typo like
  // `tru`) would arrive here as `false` and silently DISABLE PII scrubbing.
  // Measured: 'true'→true, 'false'→false, and 'tru' / 'TRUE' / '1' / 'yes' all
  // →false under dbBool. Before this merge existed those values were inert, so
  // adopting dbBool here would newly activate that footgun on a privacy knob.
  // An unrecognised value is treated as unset, which falls back to the
  // documented default (scrub on, capture per CONTRIBUTOR_MODE) — fail-safe.
  //
  // Deliberately scoped to the two keys this change introduces. The same
  // looseness applies to the other dbBool keys, but tightening those is a
  // behavior change for existing brains and belongs in its own PR.
  async function dbBoolStrict(key: string): Promise<boolean | undefined> {
    try {
      const v = await dbRaw(key);
      if (v === 'true') return true;
      if (v === 'false') return false;
      return undefined;
    } catch {
      return undefined;
    }
  }

  const dbEvalCapture = await dbBoolStrict('eval.capture');
  const dbEvalScrubPii = await dbBoolStrict('eval.scrub_pii');

  const mergedEval: NonNullable<GBrainConfig['eval']> = { ...(merged.eval ?? {}) };
  if (mergedEval.capture === undefined && dbEvalCapture !== undefined) {
    mergedEval.capture = dbEvalCapture;
  }
  if (mergedEval.scrub_pii === undefined && dbEvalScrubPii !== undefined) {
    mergedEval.scrub_pii = dbEvalScrubPii;
  }
  // Same container discipline as dream/content_sanity: a brain that sets
  // neither key keeps `cfg.eval` undefined, so `config show` does not sprout
  // an empty object and downstream `config?.eval?.x === undefined` reads are
  // unchanged.
  if (Object.keys(mergedEval).length > 0) {
    merged.eval = mergedEval;
  }

  // #4605 — search.adaptive_return* DB-plane merge, same class as #1475: the
  // keys are registered and stored, but return-policy.ts reads the NESTED
  // `cfg.search.*` of THIS merged object (via hybrid.ts), so without this the
  // row was accepted, echoed by `config get`, and never read. Strict bool;
  // caps must be finite numbers (return-policy clamps); file > DB; no empty container.
  const mergedSearch: NonNullable<GBrainConfig['search']> = { ...(merged.search ?? {}) };
  const dbAdaptiveReturn = await dbBoolStrict('search.adaptive_return');
  if (mergedSearch.adaptive_return === undefined && dbAdaptiveReturn !== undefined) {
    mergedSearch.adaptive_return = dbAdaptiveReturn;
  }
  for (const cap of ['adaptive_return_entity_max', 'adaptive_return_other_max', 'adaptive_return_min_keep'] as const) {
    if (mergedSearch[cap] !== undefined) continue;
    const n = Number(await dbStr(`search.${cap}`));
    if (Number.isFinite(n)) mergedSearch[cap] = n;
  }
  await mergeSearchScanKnobs(mergedSearch, dbStr, dbBoolStrict);
  if (Object.keys(mergedSearch).length > 0) {
    merged.search = mergedSearch;
  }

  // #2119-class read-side merge (also #2137/#4297): provider credentials,
  // chat/expansion pins, chat_fallback_chain, flat cycle.* (env > file > DB).
  // Served from the SAME snapshot as the reads above when available (zero
  // extra round trips, and the merge can't disagree with the dbStr/dbBool
  // reads); otherwise one batched, ~30s-memoized read per engine handle
  // (D2 remediation).
  await applyDbPlaneReadSideMerge(
    merged,
    snapshot
      ? {
          getConfig: async (key) => snapshot[key] ?? null,
          listConfigKeys: async (prefix) =>
            Object.keys(snapshot).filter((k) => k.startsWith(prefix)),
        }
      : engine,
  );

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
  'openrouter_api_key',
  'voyage_api_key',
  'dashscope_api_key',
  'deepseek_api_key',
  'litellm_api_key',
  'together_api_key',
  'google_api_key',
  'azure_openai_api_key',
  'azure_openai_endpoint',
  'azure_openai_deployment',
  'azure_openai_use_entra',
  'embedding_model',
  'embedding_dimensions',
  'embedding_disabled',
  'expansion_model',
  'chat_model',
  'chat_fallback_chain',
  'chat_fallback_on_refusal',
  'provider_base_urls',
  // Integration gates (file-plane, hook-lane)
  'integrations.memorable.enabled',
  // MEMORY_VERBS v1 (Cathedral 1)
  'mcp_surface',
  'protocol_installed_at',
  'provider_chat_options',
  'storage',
  'schema_pack',
  'eval',
  'eval.capture',
  'eval.scrub_pii',
  'embedding_multimodal',
  'embedding_multimodal_model',
  // #5691: per-brain query instruction (DB plane; read by search/query-prefix.ts).
  'embedding_query_prefix',
  'embedding_image_ocr',
  'embedding_image_ocr_model',
  'embedding_columns',
  'search_embedding_column',
  'remote_mcp',
  'sync',
  'sync.repo_path',
  'import.require_configured_root',
  'sync.last_commit',
  // Opt-out for the put_page/capture disk write-through (write-through.ts):
  // 'false' makes every page write DB-only. For brains whose host repo is a
  // shared working tree where stray root-level .md artifacts are unwanted.
  'sync.write_through',
  // Gateway-native subagent loop toggle (routes subagent jobs through the
  // provider-agnostic gateway.toolLoop for non-Anthropic providers). The
  // subagent handler's error message tells users to `config set` this, so it
  // must be a known key or `config set` rejects it without --force.
  'agent.use_gateway_loop',
  // #2778: per-turn output-token cap for the subagent loop (default 8192).
  'agent.max_output_tokens',
  // #4921: subagent per-turn chat timeout (minions/handler-timeouts.ts, default 30 min).
  'ai.chat.per_turn_timeout_ms',
  // File-plane bootstrap hook-lane keys (routed to ~/.gbrain/config.json by
  // `config set` — engine-free hook/push children read loadConfigFileOnly).
  'push.allow_unverified_remote',
  'hooks.stop_push_debounce_min',
  // File-plane backup-check keys (routed to ~/.gbrain/config.json by `config
  // set` — the engine-free render sites read loadConfigFileOnly). Default ON /
  // 30 days; interval clamps to >=1 day at read time (backup/status-file.ts).
  'backup.check_enabled',
  'backup.check_interval_days',
  // DB-plane search-mode knobs: one row per key mode.ts reads (its
  // KNOB_CONFIG_KEY, hand-mirrored so this module stays import-light; pinned
  // equal by test/config-search-registry.test.ts). camelCase where the code
  // reads camelCase (#4605 — snake_case rows here had no reader).
  'search.mode',
  'search.cache.enabled',
  'search.cache.similarity_threshold',
  'search.cache.ttl_seconds',
  'search.intentWeighting',
  'search.keywordOrFallback',
  'search.tokenBudget',
  'search.expansion',
  'search.searchLimit',
  'search.reranker.enabled',
  'search.reranker.model',
  'search.reranker.top_n_in',
  'search.reranker.top_n_out',
  'search.reranker.timeout_ms',
  'search.floor_ratio',
  'search.title_boost',
  'search.evidence_cosine_floor',
  'search.cross_modal.both_mode_text_weight',
  'search.cross_modal.both_mode_image_weight',
  'search.image_query.text_refinement_weight',
  'search.image_query.image_refinement_weight',
  'search.unified_multimodal',
  'search.unified_multimodal_only',
  'search.cross_modal.llm_intent',
  'search.graph_signals',
  'search.contextual_retrieval',
  'search.contextual_retrieval_disabled',
  'search.relational_retrieval',
  'search.relational_retrieval_depth',
  // DB-plane search.* singletons read directly via engine.getConfig
  // (commands/upgrade.ts, ops/image.ts, ops/search.ts, private-visibility.ts,
  // last-retrieved.ts).
  'search.mode_upgrade_notice_shown',
  'search.image_query.max_bytes',
  'search.image_query.daily_budget_usd_per_client',
  'search.image_query.remote_max_bytes',
  'search.mcp_keyword_only',
  REMOTE_PRIVATE_PAGES_KEY,
  'search.track_retrieval',
  // Retrieval feedback (feedback/settings.ts).
  'feedback.enabled', 'feedback.learn', 'feedback.influence', 'feedback.implicit', 'feedback.alpha',
  'feedback.max_ratings_per_hour', 'feedback.event_retention_days', 'feedback.rating_prompt', 'feedback.notice_shown',
  // #4415: per-brain query-intent pattern extensions (JSON bank→regex[]),
  // merged over the shipped banks in src/core/search/query-intent.ts.
  'search.intent_patterns',
  // Per-brain source-boost map (`prefix:factor,...`; `none` drops the
  // defaults), read by search/mode.ts loadSearchModeConfig and ops/search.ts.
  'search.source_boosts',
  // #5428 opt-in single-token alias hop (`true` enables), read by
  // search/mode.ts loadSearchModeConfig.
  'search.alias_token_hop',
  // 2026-08 fix wave (E5a): the adaptive-return / autocut / CRAG knobs were
  // read by the search path but never registered — `gbrain config set`
  // rejected them, making the documented config plane a no-op. Read sites:
  // return-policy.ts (adaptive_return*), mode.ts (autocut*), ops/search.ts
  // (crag_*). NOTE: `search.crag_think` (default off) runs `think` — an LLM
  // call — on weak-graded local queries when enabled; it respects
  // spend.posture, but enabling it is a per-query spend decision.
  // `search.crag_escalation` (default off) also spends when enabled: the
  // high-ceiling re-run sets expansion=true (one LLM multi-query call per
  // weak-graded query), and unlike crag_think it is reachable by remote
  // callers — attacker-shaped weak queries drive that spend (ship security
  // review). See docs/operations/spend-controls.md.
  // #5824 one-release rollback, latched per process (search/vector-legacy-guard.ts).
  'search.vector_legacy_guard',
  'search.hnsw_iterative_scan',
  'search.cjk_keyword_deadline_ms',
  'search.adaptive_return',
  'search.adaptive_return_entity_max',
  'search.adaptive_return_other_max',
  'search.adaptive_return_min_keep',
  'search.autocut',
  'search.autocut_jump',
  'search.autocut_min_keep',
  'search.autocut_min_top',
  // Ranker wave: shared RRF weight budget for expansion variant lists (mode.ts reads; `legacy` | (0, 4]).
  'search.expansion_variant_budget',
  // Ranker wave (R1): relational-arm rows re-pinned above reranked text rows (mode.ts reads; `off` | 0..10).
  'search.relational_rerank_pin',
  // Multi-hop planner (mode.ts reads; boolean) and typed one-hop orientation (boolean; unset follows the planner).
  'search.relational_planner',
  'search.relational_orient_onehop',
  // Multi-hop chain slots: chain rows leading page 1 when a chain fired (mode.ts reads; 0..10).
  'search.relational_chain_slots',
  // Ranker wave (Phase E2): keyword-arm confidence floor — weak keyword arm fuses at half weight (mode.ts reads; `off` | (0, 1]).
  'search.keyword_arm_confidence_floor',
  // Ranker wave (Phase E3): metadata boost gate — `lexical` skips post-fusion metadata boosts when the vector arm was the only voter (mode.ts reads; `always` | `lexical`).
  'search.metadata_boost_gate',
  'search.crag_escalation',
  'search.crag_think',
  // Evidence delivery (search/evidence-delivery.ts): default unit (auto),
  // window radius, default/auto/remote-max token budgets; think reads its own unit.
  'search.return_unit',
  'search.return_window',
  'search.return_budget_default',
  'search.return_budget_conversation',
  'search.return_budget_max_remote',
  'search.evidence_date_header', // C1: one-line date header per delivered block (default off; search/evidence-date.ts)
  'search.entity_anchoring', // entity-anchored retrieval for entity-scoped current-state query/search (default off; search/entity-anchor.ts)
  'search.query_facts_arm', // query adds matching active facts as rows in spare capacity (default on; search/facts-arm.ts)
  'search.temporal_fact_reserve', // temporal-cue queries reserve up to 15% of the token budget for question-ranked dated facts (default off; search/facts-arm.ts)
  'think.return_unit',
  // Models tier system (v0.31.12)
  'models.default',
  'models.tier.utility',
  'models.tier.reasoning',
  'models.tier.deep',
  'models.tier.subagent',
  'models.aliases',
  'models.dream.synthesize',
  'models.dream.extract_atoms',
  'cycle.extract_atoms.budget_usd',
  // #4907: synthesize_concepts phase budget (finite USD > 0, default 1.5); cycle/phase-config-values.ts.
  'cycle.synthesize_concepts.budget_usd',
  'cycle.extract_atoms.max_source_chars',
  'cycle.extract_atoms.page_discovery_budget',
  // #4540: per-item extractor caps (defaults 50000 chars / 4096 tokens) plus
  // an optional between-item pacing sleep (ms, default 0). Read via
  // engine.getConfig in src/core/cycle/extract-atoms.ts.
  'cycle.extract_atoms.max_input_chars',
  'cycle.extract_atoms.max_output_tokens',
  'cycle.extract_atoms.pacing_ms',
  'models.dream.patterns',
  'models.dream.synthesize_verdict',
  // #4152: preferred triage-model key (explicit pre-read in loadSynthConfig;
  // wins over models.dream.synthesize_verdict + dream.synthesize.verdict_model).
  'models.dream.triage',
  'models.drift',
  'models.auto_think',
  'models.standing_questions',
  'models.think', 'models.fence_repair', // models.fence_repair: #6188 Tier 3 fence repair model (fence-repair/llm.ts), tier deep
  'models.subagent',
  'models.expansion',
  'models.contextual_synopsis',
  'models.chat',
  'models.brainstorm.judge',
  'models.eval.longmemeval', 'models.eval.cross_modal.slot_a', 'models.eval.cross_modal.slot_b', 'models.eval.cross_modal.slot_c', // #5872 D12 probe judge slots
  'facts.extraction_model',
  // Brain-wide kill switch for fact extraction, read by
  // src/core/facts/extract.ts:isFactsExtractionEnabled and honored by
  // sweep.ts, operations.ts and transcripts/ingest-facts.ts. That function's
  // own docstring tells operators to flip it with
  // `gbrain config set facts.extraction_enabled false` — which was rejected
  // as an unknown key until this registration.
  'facts.extraction_enabled',
  // Open-loop engine kill switch: LLM commitment/decision extraction over
  // google-source email pages (default ON for google sources; deterministic
  // thread detection is unaffected). `gbrain config set loops.extraction_enabled false`.
  'loops.extraction_enabled',
  // #2113: output-token cap for the per-turn facts extractor (default 4000).
  'facts.extraction_max_tokens',
  // Automatic facts drain caps (src/core/facts/drain.ts FACTS_DRAIN_KEYS).
  'facts.drain_budget_usd', 'facts.drain_daily_budget_usd', 'facts.drain_max_jobs',
  // #3852: operator-set system-prompt appendix for the facts extractor (e.g.
  // a durable-vs-ephemeral rubric for agent work-session transcripts).
  // Composes with BOTH honest-notability prompt variants.
  'facts.extraction_prompt_appendix',
  // #3852: kill-switch for the deterministic junk gate on extracted fact text
  // (plan narration / provider error strings / meta-chatter). Default on.
  'facts.extraction_junk_filter',
  // B-16: confidence stored for an extracted candidate whose confidence is
  // missing or non-numeric (a number in 0..1). Unset keeps the legacy 1.0.
  'facts.extraction_missing_confidence',
  'extraction.date_grounding', 'facts.attribution', // extraction prompt variants (facts/extract.ts getExtractorVariant)
  // [ENG-8] Brain-level default visibility for facts writes when the caller
  // didn't specify one: 'private' (default) | 'world'. Resolved by
  // src/core/facts/visibility.ts; explicit caller values always win.
  'facts.default_visibility',
  'facts.entity_inference', // #5836: write-time subject inference kill switch (subject-infer.ts)
  'facts.candidate_fusion', // C2: 'rrf_free' (default, cosine arm) | 'interleave' (cosine + keyword; facts/single-prepare.ts)
  'facts.supersession_thresholds', // JSON {"provider:model@dims": number | "off"} (facts/supersession-threshold.ts)
  // Ambient memory writeback (opt-in, default OFF): 'off' | 'salient' | 'all'.
  // DUAL-PLANE: `gbrain config set` writes the DB plane (authoritative — the
  // serve-side harvest gate re-checks it) AND mirrors into the file plane's
  // `memory` slot (read by the engine-free Stop-hook child and the stdio
  // serve's boot resolve). Resolved by src/core/facts/writeback-config.ts.
  'memory.auto_writeback',
  // TTL the instruction template tells agents to pass on TRANSIENT facts
  // (health/location/travel/mood/near-term schedule). Duration shorthand
  // only ('3d', '12h'), positive, capped at 365d; default '3d'.
  'memory.auto_writeback_transient_ttl',
  // Fire-once sentinel for the ambient-writeback consent nudge (WP8):
  // stamped 'true' after the init/post-upgrade ask has been shown once.
  'memory.auto_writeback_notice_shown',
  // Always-loaded core memory + context-pressure notice (docs/guides/core-memory.md#configuration).
  'memory.core.enabled', 'memory.core.max_chars', 'memory.core.remote_edit',
  'memory.pressure.enabled', 'memory.pressure.warn_ratio', 'memory.pressure.context_window',
  // Declared brain audience: 'personal' | 'shared'. Set by the operator, by
  // company-brainify's Phase-5 handoff (shared), or from the bootstrap
  // interview. Declaration beats the conservative client-count heuristic in
  // src/core/facts/writeback-audience.ts; the consent nudge fires only on
  // personal brains and never auto-enables anything.
  'brain.audience',
  // Conversation parser LLM fallback. Deliberately register the exact key,
  // not a conversation_parser.* prefix: fallback is the only opt-in consumer.
  'conversation_parser.llm_fallback_enabled',
  // Dream cycle config
  'dream.synthesize.session_corpus_dir', 'dream.synthesize.conversation_pages', // #4419 conversation pages feed synthesis
  'dream.synthesize.meeting_transcripts_dir',
  'dream.synthesize.last_completion_ts',
  'dream.synthesize.verdict_model',
  'dream.synthesize.max_prompt_tokens',
  'dream.synthesize.max_chunks_per_transcript',
  // #2415: top-level namespace for synthesize/patterns output (default 'wiki').
  'dream.synthesize.output_root',
  'dream.synthesize.subagent_timeout_ms',
  'dream.synthesize.subagent_wait_timeout_ms',
  // #4152 two-stage cascade: subagent turn budget (default 16) + opt-in
  // per-source daily submission cap (default 0 = disabled; 200 recommended
  // for busy deployments).
  'dream.synthesize.max_turns',
  'dream.synthesize.max_submissions_per_source_per_day',
  // #4216/#4194 dream-wave knobs: synthesis execution mode ('oneshot'
  // default | 'agentic'), pre-retrieval link-candidate manifest (default on),
  // and inline-drain concurrency (default 1; clamped [1,8]; PGLite forced 1).
  'dream.synthesize.mode',
  'dream.synthesize.link_manifest',
  'dream.synthesize.quote_verify',
  'dream.quote_verify',
  'think.quote_verify',
  'dream.synthesize.inline_concurrency',
  // #4152 triage knobs. The triage model's preferred key is
  // `models.dream.triage` (models.* prefix, registered via the models.dream.*
  // family); these tune the gate + sampling + pass budget.
  'dream.triage.threshold',
  'dream.triage.rescue_floor',
  'dream.triage.rescue_min_segments',
  'dream.triage.rescue_content_types',
  'dream.triage.max_chars',
  'dream.triage.max_tokens',
  'dream.triage.max_ms',
  'dream.triage.concurrency',
  // #4494: propose_takes extractor output caps (defaults 2048/4096, floor
  // 256, retry clamped >= base). Thinking models spend reasoning tokens
  // inside maxTokens, so the hardcoded defaults truncated every dense page.
  'dream.propose_takes.max_tokens',
  'dream.propose_takes.retry_max_tokens',
  // #5958: per-call extractor timeout (whole ms 1000..300000; unset scales with the output cap); cycle/phase-config-values.ts.
  'dream.propose_takes.call_timeout_ms',
  'dream.patterns.lookback_days',
  'dream.patterns.min_evidence',
  // #2782-family: patterns-phase subagent timeouts (mirror of the
  // dream.synthesize.* pair from #1594).
  'dream.patterns.subagent_timeout_ms',
  'dream.patterns.subagent_wait_timeout_ms',
  // Paid-loop breaker: dead submissions of one dream key within 24h before
  // it is refused (default 3; 0 disables). `gbrain dream reset-key` clears one.
  'dream.breaker.max_dead_submissions',
  // Emotional weight (v0.29)
  'emotional_weight.high_tags',
  'emotional_weight.user_holder',
  // Cycle phase config
  // #4348: IANA timezone that owns the dream-cycle calendar day (summary
  // bucketing). Unset → host timezone → UTC. Validated at set time.
  'cycle.timezone',
  'cycle.consolidate.cluster_threshold', // #5363: (0, 1], default 0.85; read + validated in cycle/phases/consolidate.ts
  // A11: IANA timezone for offset-less frontmatter datetimes in effective_date.
  // Unset → UTC (date-only values are always UTC calendar dates). Validated at set time.
  'brain.timezone',
  // A12 (opt-in, default off): undated new pages in git-backed sources take the
  // file's git first-commit date as their effective-date fallback on full import.
  'sync.git_first_commit_dates',
  'cycle.grade_takes.write_gstack_learnings',
  // #4102: off switch for the propose_takes LLM phase (default ON; the
  // phase ships in the default list). Read by src/core/cycle/propose-takes.ts.
  'cycle.propose_takes.enabled',
  // Content sanity (v0.41)
  'content_sanity.bytes_warn',
  'content_sanity.bytes_block',
  'content_sanity.junk_patterns_enabled',
  'content_sanity.disabled',
  // Content-quality gate (v0.42, issue #1699)
  'content_sanity.junk_disposition',
  'content_sanity.max_markup_ratio',
  'content_sanity.prose_check_enabled',
  // #4702: per-pattern opt-out (JSON array or comma-separated names) —
  // finer than junk_patterns_enabled (all patterns) / disabled (kill-switch).
  'content_sanity.disabled_patterns',
  // MCP skill-catalog publishing (PR1)
  'mcp.publish_skills',
  'mcp.publish_skills_prompted',
  'mcp.skills_dir',
  // MCP advisor publishing (#2180): separate gate from publish_skills because
  // the advisor exposes operational diagnostics (version/jobs/key presence),
  // not prose skills. Default OFF; read-only over MCP.
  'mcp.publish_advisor',
  // WP3 — unknown tool-call argument posture ('warn' default | 'reject').
  // Read dual-plane by src/mcp/validate-params.ts (DB > file > 'warn').
  'mcp.strict_params',
  'mcp.result_rows', // C1 row shape, read dual-plane by src/mcp/result-rows.ts
  'mcp.allow_session_widen', // stdio request_tools session widening (default on), read dual-plane by src/mcp/surface.ts
  // Skill-nag suppression (#2180): brain-resident pack install nag off-switch.
  'skillpack.nag_disabled',
  // Self-upgrade (v0.42; file plane, read on the hot path)
  'self_upgrade.mode',
  'self_upgrade.mode_prompted',
  'self_upgrade.quiet_hours',
  'self_upgrade.failed_versions',
  'self_upgrade.attempting_version',
  'self_upgrade.last_check_ts',
  'self_upgrade.last_applied_version',
  // Misc
  'artifacts_sync_mode',
  'cross_project_learnings',
  // Link resolution (issue #972; cross_source is issue #2589)
  'link_resolution',
  'link_resolution.global_basename',
  'link_resolution.cross_source',
  // Spend controls (v0.42.42.0, issue #2139). Previously `--force`-only — the
  // operator had to discover these by reading source. Registered so `config
  // set` accepts them directly. See docs/operations/spend-controls.md.
  'spend.posture',
  'pricing.overrides',
  // Life Chronicle (#2390, #5876): automatic event extraction, on by default
  // (unset = on). The documented opt-out is `gbrain config set auto_chronicle
  // false`; read by core/chronicle/config.ts.
  'auto_chronicle',
  // Auto-link toggle read by the put_page post-hook (link-extraction.ts),
  // reconcile-links, and sweep. The documented off-switch is `gbrain config
  // set auto_link false` — same unregistered-key class as auto_chronicle.
  'auto_link',
  // Entity mention index (core/mentions/policy.ts): off switch, +type/-type linkable types, names never linked, pages never linked (#5829).
  'mentions.auto_link', 'mentions.entity_types', 'mentions.ignore', 'mentions.exclude_slugs',
  // #4987: the write-path timeline extractor's off switch (read by
  // isAutoTimelineEnabled); registered so `gbrain config set auto_timeline off`
  // works without --force, as the compiled-truth guide documents.
  'auto_timeline',
  // Wanted pages: record unresolved authored links and wake their origins
  // when the target appears (src/core/wanted-links.ts). On by default; the
  // off switch is `gbrain config set wanted_pages.enabled false`.
  'wanted_pages.enabled',
  // Remote writes (the persistence `links` effect) record missing mention targets too. On by default (held-out verdict H8).
  'wanted_pages.remote',
  // Line grammar (src/core/line-grammar.ts): typed relation lines, off by default
  // (held-out verdict H3); undeclared relation types fall back to inference unless allowed.
  'line_grammar.enabled',
  'line_grammar.allow_undeclared_types',
  // Validity ranges on typed relation lines stored as dated edge transitions
  // (core/link-effective.ts). On by default (held-out verdict H7); applies while line_grammar.enabled is on.
  'line_grammar.effective_ranges',
  // put_page "did you mean an existing page?" advisory on creates (core/similar-pages.ts). Off by default (held-out verdict H5b).
  'put_page.similar_pages',
  // #5584: skillopt optimizer output cap (default 32000 thinking / 4096 otherwise).
  'skillopt.reflect_max_tokens',
  // #5585: skillopt strict model provenance (true|1|yes|on; other values count as on).
  'skillopt.models_strict',
  // #2606: chronicle judge output-token cap (default 4000). Event-dense
  // pages overflowed the old hardcoded 1500 and were misrecorded as
  // no_events; the cap is now configurable and truncation is surfaced.
  'chronicle.judge_max_tokens',
  'chronicle.job_budget_usd', 'chronicle.auto_daily_limit', 'chronicle.auto_recent_days', 'chronicle.auto_settle_seconds', // #5876 rails (chronicle/config.ts validates)
  // Takes bootstrap (v0.41.18.0, A12). The onboard remediation's two-gate
  // consent reads this key, and enabling it is the documented path to
  // `gbrain takes extract --from-pages` — same unregistered-key class.
  'takes.bootstrap_enabled',
  // #5885: `embed --stale` (cycle embed phase, migration drain) also embeds
  // stale takes; `false` turns that off (GBRAIN_EMBED_TAKES=0 overrides).
  'takes.auto_embed',
  // B-14: USD cap for one takes-bootstrap run's classifier calls (default 5.0;
  // 0 disables). Read by src/core/extract-takes-from-pages.ts.
  'takes.bootstrap_budget_usd',
  // Orphan reporting scope. These are consumed by core/orphan-policy.ts and
  // documented there as the per-brain override path.
  'orphans.exclude_prefixes',
  'orphans.exclude_slugs',
  'sync.cost_gate_min_usd',
  'sync.federated_v2',
  'sync.include_working_tree',
  // #5984: managed Postgres sync publishes pages in bulk groups (on by default; each page keeps its own request).
  'sync.bulk',
  'sync.bulk_size',
  'sync.bulk_max_txn_ms',
  'sync.lanes',
  // Persisted indexing scope (comma/newline-separated glob list; trailing '/'
  // normalizes to a '/**' subtree glob). Read best-effort at the top of
  // performSyncInner and UNIONED with any per-call --exclude so internal
  // callers (autopilot, minion sync jobs, dream cycle) honor the same scope.
  // Registering it here is what makes `gbrain config set sync.exclude ...`
  // work — the operator path to the feature (unregistered-key class).
  'sync.exclude',
  // #4901: the dot-directory WAIVER's persisted twin (unioned with the per-call
  // include-hidden flag, which bulk sync refuses); registered so `config set` accepts it.
  'sync.include_hidden',
  // #5988: Git sync holds (read by readSyncHoldPolicy). `sync.holds=fail`
  // restores fail-closed blocking; the rest tune detail, escalation and the
  // parser-regression stop. Registered so the documented `config set` works.
  'sync.holds',
  'sync.hold_cap',
  'sync.hold_escalate_count',
  'sync.hold_escalate_pct',
  'sync.parser_regression',
  'fences.normalize', // #6188: inline Tier 1 fence normalization (fence-repair/config.ts); default on
  'fences.repair.enabled', 'fences.repair.llm', // #6188: the fence_repair cycle phase and its Tier 3 model step (fence-repair/config.ts); default on
  'fences.repair.max_usd_per_page', 'fences.repair.max_usd_per_day', // #6188: Tier 3 fence repair caps; 0 = no model spend
  // #2179: clamp window for DCR-requested per-client token TTLs. Read by
  // `gbrain serve --http` at startup; unset min defaults to 300s, unset max
  // defaults fail-closed to max(--token-ttl, min).
  'oauth.dcr_ttl_min_seconds',
  'oauth.dcr_ttl_max_seconds',
  'embed.backfill_cooldown_min',
  'embed.backfill_max_usd_per_source_24h',
  'embed.backfill_max_usd',
  // Brain-level default source. Read by source-resolver.ts tier 5
  // (`engine.getConfig('sources.default')`) and written by
  // `gbrain sources default <id>`. Listed here so `gbrain config set`
  // stops claiming "Nothing in gbrain reads this" for a key the resolver
  // reads on every unqualified call.
  'sources.default',
  // Alias/undeclared explicit-type warnings at sync/import (default on).
  // Read by performSync + runImport summary aggregation; 'false'/'0'/'off'
  // silences both surfaces (schema lint rules stay active).
  'schema.type_warnings',
  // #4795 reindex-search-vector marker (doctor fts_reindex_incomplete reads it); `config unset` is the escape hatch.
  'fts.reindex_in_progress',
  // #5470: managed-write journal caps + receipt retention, read by
  // persistence/limits.ts (JOURNAL_CONFIG_KEYS; drift-guarded by test).
  'persistence.limits.principal_outstanding', 'persistence.limits.brain_outstanding',
  'persistence.limits.principal_intent_bytes', 'persistence.limits.brain_intent_bytes',
  'persistence.limits.principal_lifetime_ids', 'persistence.limits.brain_lifetime_ids',
  'persistence.limits.principal_terminal_bytes', 'persistence.limits.brain_terminal_bytes',
  'persistence.limits.brain_recovery_bytes', 'persistence.limits.worktree_recovery_bytes',
  'persistence.receipt_retention_days', 'persistence.unbound_write', 'persistence.max_claim_ms', // #5254: persistence/unbound-source.ts; #6176: persistence/claim-phase.ts
  // shared-skills migration inventory bounds (src/core/shared-skills/inventory-limits.ts)
  'shared_skills.inventory.max_files', 'shared_skills.inventory.max_total_bytes', 'shared_skills.inventory.max_file_bytes', 'shared_skills.inventory.max_entries',
  'persistence.write_wait_ms', // #5232: file plane, persistence/write-wait.ts
  'migrate.graduation', // file plane, src/commands/migrate-graduation.ts (engine graduation opt-out)
  'consent.preapprove.paid.max_usd_per_run', 'consent.preapprove.persistent_install', // A4: file plane, core/consent.ts
  // F4b: PGLite row-delta ANALYZE (src/core/planner-stats.ts); F4a: get_health memo TTL (src/core/health-memo.ts, 0 disables).
  'planner.auto_analyze', 'planner.first_read_budget_ms', 'import.analyze_every_pages', 'health.cache_ttl_ms',
];

/**
 * v0.37 (D6): well-known prefix patterns for DB-plane keys that have
 * unbounded sub-keys. Used as a softer gate before falling back to
 * Levenshtein suggestion in `gbrain config set`.
 */
export const KNOWN_CONFIG_KEY_PREFIXES: readonly string[] = [
  'search.',           // search.* (mode, cache.*, etc.); config set refuses unregistered leaves (commands/config/enumerated-keys.ts)
  'graph.',            // graph.edge_validity (temporal typed-edge read policy, src/core/link-validity.ts)
  'models.',           // models.* (tier, aliases, per-task)
  'dream.',            // dream.synthesize.*, dream.patterns.*
  'cycle.',            // cycle.<phase>.*
  'embedding_columns.', // per-column overrides
  'provider_base_urls.', // per-provider base URL overrides
  'provider_chat_options.', // per-provider / per-model chat providerOptions
  'content_sanity.',    // v0.41 content-sanity tunables; enumerated like search.
  'mcp.',               // mcp.publish_skills, mcp.skills_dir (PR1 skill catalog)
  'autopilot.',         // autopilot.nightly_quality_probe.*, autopilot.auto_drain.* (#1685)
  'chronicle.',         // Life Chronicle knobs; config set refuses leaves outside CHRONICLE_CONFIG_KEYS (#5876)
  'self_upgrade.',      // v0.42 self-upgrade (mode, quiet_hours, state)
  // Queue admission control (per-name sub-keys):
  //   minions.coalesce_params.<name>, minions.ttl_waiting_hours.<name>,
  //   minions.quota_max_waiting.<name>, plus the one-time
  //   minions.ttl_notice_shown flag. Booleans via the canonical truthiness
  //   parser; numeric 0 disables.
  'minions.',
  'pace.',              // pace.mode + PACE_MODE_CONFIG_KEYS (src/core/pace-mode.ts)
  'decide.',            // System One decide.* (validated by src/core/ai/decide/config.ts DECIDE_CONFIG_KEYS)
  'connectors.',        // chat-connectors: source_id, sync_floor_min, embed_kickoff_min_pages, doctor_stale_hours, <provider>.{auto_sync,last_sync_at,auth_error_at,watermark_iso} (no secrets — creds are file-plane)
];

/**
 * Canonical truthiness for DB-plane boolean config values (#2753).
 *
 * Config values arrive as opaque strings from `gbrain config set`, so every
 * reader has to decide what counts as "on". Left to each call site those sets
 * drift, and the drift is silent in the worst possible way: the doctor accepted
 * `yes`/`on` while the subagent worker accepted only `true`/`1`, so
 * `gbrain config set agent.use_gateway_loop yes` produced a healthy doctor
 * report AND a runtime refusal of the very job the setting was supposed to
 * enable. One parser, used by every reader, is what keeps a green health check
 * honest.
 *
 * Accepts `true` / `1` / `yes` / `on` (case-insensitive, surrounding whitespace
 * trimmed). Everything else — including `null`, non-strings, and the empty
 * string — is false, so an unset or garbled value fails closed.
 */
export function isConfigTruthy(raw: unknown): boolean {
  return typeof raw === 'string'
    && ['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export function saveConfig(config: GBrainConfig): void {
  mkdirSync(getConfigDir(), { recursive: true });
  // Atomic write (tmp + rename): long-lived workers re-read this file per job
  // (gateway env refresh, keyed/keyless classification) — a truncate-then-write
  // here could be read torn, making a keyed install classify as keyless and
  // calmly consume work it should retry.
  const tmp = `${getConfigPath()}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, getConfigPath());
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
  // Same #427 guard as loadConfig: a DATABASE_URL that Bun auto-loaded from
  // a cwd .env file is not an operator-provided source. Keeping this in
  // lockstep with loadConfig matters because doctor uses this to tell the
  // user where the URL came from — reporting env:DATABASE_URL while
  // loadConfig ignores it would send them debugging the wrong layer.
  if (effectiveEnvDatabaseUrl()) return 'env:DATABASE_URL';
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
