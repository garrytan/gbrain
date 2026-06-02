import { execSync } from 'child_process';
import { readdirSync, lstatSync, existsSync, copyFileSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { saveConfig, loadConfig, loadConfigFileOnly, toEngineConfig, gbrainPath, configPath, isThinClient, type GBrainConfig } from '../core/config.ts';
import { createEngine } from '../core/engine-factory.ts';
import { discoverOAuth, mintClientCredentialsToken, smokeTestMcp } from '../core/remote-mcp-probe.ts';

export async function runInit(args: string[]) {
  // Help guard: cli.ts only routes --help to printOpHelp() for shared-op
  // commands; CLI_ONLY commands (init, embed, etc.) fall through to their
  // handler with --help in argv. Without this guard, `gbrain init --help`
  // proceeds into the smart-detection branch below, scans cwd for .md files,
  // and on a directory with 1000+ files (e.g. $HOME for someone whose brain
  // and notes share a root) silently overwrites the existing Supabase config
  // with a fresh PGLite brain at ~/.gbrain/brain.pglite. Confirmed in the
  // wild — flipped a working `engine: postgres` config to `engine: pglite`
  // on a brain with 10K+ pages. Help should never mutate state.
  if (args.includes('--help') || args.includes('-h')) {
    printInitHelp();
    return;
  }

  const isSupabase = args.includes('--supabase');
  const isPGLite = args.includes('--pglite');
  const isMcpOnly = args.includes('--mcp-only');
  const isForce = args.includes('--force');
  const isNonInteractive = args.includes('--non-interactive');
  const isMigrateOnly = args.includes('--migrate-only');
  const jsonOutput = args.includes('--json');
  const urlIndex = args.indexOf('--url');
  const manualUrl = urlIndex !== -1 ? args[urlIndex + 1] : null;
  const keyIndex = args.indexOf('--key');
  const apiKey = keyIndex !== -1 ? args[keyIndex + 1] : null;
  const pathIndex = args.indexOf('--path');
  const customPath = pathIndex !== -1 ? args[pathIndex + 1] : null;
  // v0.42 (T17): pack selection on fresh installs. New brains default to
  // gbrain-base-v2 (the 15-type canonical taxonomy); --schema-pack
  // gbrain-base opts back to the legacy 24-type pack for users who don't
  // want the new taxonomy on day one. Existing brains stay on whatever
  // schema_pack their config.json already says.
  const schemaPackIdx = args.indexOf('--schema-pack');
  const schemaPack = schemaPackIdx !== -1 && args[schemaPackIdx + 1]
    ? args[schemaPackIdx + 1]
    : 'gbrain-base-v2';

  // Multi-topology v1: thin-client init. Skips local engine entirely; writes
  // remote_mcp config that the CLI dispatch guard reads to refuse DB-bound ops.
  if (isMcpOnly) {
    return initRemoteMcp({ args, jsonOutput, isForce, isNonInteractive });
  }

  // Re-run guard (A8): if thin-client config is already present, refuse to
  // create a local engine without --force. Catches the scripted-setup-loop
  // friction (running setup-gbrain repeatedly on a thin-client machine).
  const existing = loadConfig();
  if (isThinClient(existing) && !isForce && !isMigrateOnly) {
    const url = existing!.remote_mcp!.mcp_url;
    const msg = `Thin-client config already present at ${configPath()} (remote_mcp.mcp_url=${url}).\n` +
      `Re-init would create a local engine and conflict with the remote MCP setup.\n` +
      `Use --force to overwrite, or \`gbrain init --mcp-only --force\` to refresh thin-client config.`;
    if (jsonOutput) {
      console.log(JSON.stringify({ status: 'error', reason: 'thin_client_config_present', mcp_url: url, message: msg }));
    } else {
      console.error(msg);
    }
    process.exit(1);
  }

  // Schema-only path: apply initSchema against the already-configured engine
  // without ever calling saveConfig. Used by apply-migrations, the stopgap
  // script, and the postinstall hook. Bare `gbrain init` defaults to PGLite
  // and overwrites any existing Postgres config — we must never take that
  // branch from a migration orchestrator.
  //
  // IMPORTANT: this short-circuit MUST run BEFORE resolveAIOptions() so
  // migrate-only callers (which already have a configured brain) don't
  // trigger env-detection / picker / fail-loud paths designed for fresh
  // installs.
  if (isMigrateOnly) {
    return initMigrateOnly({ jsonOutput });
  }

  // v0.14: AI provider selection.
  // --embedding-model PROVIDER:MODEL (verbose) or --model PROVIDER (shorthand, picks recipe default)
  const embModelIdx = args.indexOf('--embedding-model');
  const modelShortIdx = args.indexOf('--model');
  const embDimsIdx = args.indexOf('--embedding-dimensions');
  const expModelIdx = args.indexOf('--expansion-model');
  // v0.27: --chat-model PROVIDER:MODEL — default subagent driver.
  const chatModelIdx = args.indexOf('--chat-model');
  // v0.37 (D9): --no-embedding opts into deferred-setup mode (D9 escape hatch).
  const noEmbedding = args.includes('--no-embedding');
  const aiOpts = await resolveAIOptions({
    verbose: embModelIdx !== -1 ? args[embModelIdx + 1] : null,
    shorthand: modelShortIdx !== -1 ? args[modelShortIdx + 1] : null,
    dimsArg: embDimsIdx !== -1 ? parseInt(args[embDimsIdx + 1], 10) : null,
    expansion: expModelIdx !== -1 ? args[expModelIdx + 1] : null,
    chat: chatModelIdx !== -1 ? args[chatModelIdx + 1] : null,
    noEmbedding,
    nonInteractive: isNonInteractive,
  });

  // Explicit PGLite mode
  if (isPGLite || (!isSupabase && !manualUrl && !isNonInteractive)) {
    // Smart detection: scan for .md files unless --pglite flag forces it
    if (!isPGLite && !isSupabase) {
      const fileCount = countMarkdownFiles(process.cwd());
      if (fileCount >= 1000) {
        console.log(`Found ~${fileCount} .md files. For a brain this size, Supabase gives faster`);
        console.log('search and remote access ($25/mo). PGLite works too but search will be slower at scale.');
        console.log('');
        console.log('  gbrain init --supabase   Set up with Supabase (recommended for large brains)');
        console.log('  gbrain init --pglite     Use local PGLite anyway');
        console.log('');
        // Default to PGLite, let the user choose Supabase if they want
      }
    }

    return initPGLite({ jsonOutput, apiKey, customPath, aiOpts, schemaPack });
  }

  // Supabase/Postgres mode
  let databaseUrl: string;
  if (manualUrl) {
    databaseUrl = manualUrl;
  } else if (isNonInteractive) {
    const envUrl = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
    if (envUrl) {
      databaseUrl = envUrl;
    } else {
      console.error('--non-interactive requires --url <connection_string> or GBRAIN_DATABASE_URL env var');
      process.exit(1);
    }
  } else {
    databaseUrl = await supabaseWizard();
  }

  return initPostgres({ databaseUrl, jsonOutput, apiKey, aiOpts, schemaPack });
}

interface ResolveAIOptionsArgs {
  verbose: string | null;        // --embedding-model
  shorthand: string | null;      // --model
  dimsArg: number | null;        // --embedding-dimensions
  expansion: string | null;      // --expansion-model
  chat: string | null;           // --chat-model
  noEmbedding: boolean;          // --no-embedding (D9)
  nonInteractive: boolean;       // --non-interactive (forces D3 fail-loud, no picker)
}

interface ResolvedAIOptions {
  embedding_model?: string;
  embedding_dimensions?: number;
  expansion_model?: string;
  chat_model?: string;
  /** v0.37 (D9): user opted into deferred embedding setup. */
  noEmbedding?: boolean;
}

/**
 * Resolve AI provider options for `gbrain init`.
 *
 * Precedence (per touchpoint, top wins):
 *   1. Explicit flag (--embedding-model / --expansion-model / --chat-model)
 *   2. Shorthand flag (--model PROVIDER) for embedding only
 *   3. Env detection: walk env-ready recipes, group by provider id (D1-D4, D10).
 *      - Exactly one provider ready AND has the touchpoint → auto-pick + stderr notice.
 *      - Multiple ready → for embedding: TTY → picker (D1), non-TTY → fail loud (D3).
 *        For chat/expansion: leave default (gateway falls back at call time, D10).
 *      - Zero ready → for embedding: TTY → picker offers env-ready recipes
 *        OR setup hint with typo detection (D13); non-TTY → fail loud (D3).
 *
 * --no-embedding (D9) opt-in: skips embedding tier resolution entirely;
 * persists nulls; embed callsites refuse with a config-set hint.
 */
async function resolveAIOptions(opts: ResolveAIOptionsArgs): Promise<ResolvedAIOptions> {
  const { verbose, shorthand, dimsArg, expansion, chat, noEmbedding, nonInteractive } = opts;
  const out: ResolvedAIOptions = {};

  // --- D5: persisted config wins on re-init -----------------------------------
  // When `~/.gbrain/config.json` already has embedding_model set (a re-init
  // against an existing brain), honor it BEFORE env detection. Without this
  // the env-detection branch fires unnecessarily on every re-init, and a
  // non-TTY re-init with no env keys exits 1 (D3) even though the brain is
  // already correctly configured. Caught by CI's E2E init sequence where
  // multiple tests share `~/.gbrain` and only the first init has flags.
  //
  // The deferred-setup sentinel (`embedding_disabled: true`) is also honored —
  // a re-init without --no-embedding shouldn't re-trigger fail-loud when the
  // user already opted into deferred mode.
  try {
    const { loadConfig } = await import('../core/config.ts');
    const cfg = loadConfig();
    if (cfg?.embedding_disabled) {
      out.noEmbedding = true;
    } else if (cfg?.embedding_model) {
      out.embedding_model = cfg.embedding_model;
      if (cfg.embedding_dimensions) out.embedding_dimensions = cfg.embedding_dimensions;
    }
    if (cfg?.expansion_model) out.expansion_model = cfg.expansion_model;
    if (cfg?.chat_model) out.chat_model = cfg.chat_model;
  } catch {
    // loadConfig throws when no brain configured — first-time install, fall
    // through to env detection.
  }

  // --- Tier 1+2: explicit flags ---------------------------------------------

  if (verbose) {
    out.embedding_model = verbose;
  } else if (shorthand) {
    const { getRecipe } = await import('../core/ai/recipes/index.ts');
    const recipe = getRecipe(shorthand);
    if (!recipe) {
      console.error(`Unknown provider: ${shorthand}. Run \`gbrain providers list\` to see known providers.`);
      process.exit(1);
    }
    // v0.32 D8=A: recipes flagged user_provided_models (litellm, llama-server)
    // refuse implicit "first model" pick with a setup hint pointing the user
    // at the explicit form. The shorthand --model is meaningless for these
    // recipes because there's no canonical first model.
    if (recipe.touchpoints.embedding?.user_provided_models === true) {
      console.error(
        `Provider ${shorthand} requires you to specify the model + dimensions explicitly:\n` +
        `  gbrain init --embedding-model ${shorthand}:<your-model-id> --embedding-dimensions <N>\n` +
        (recipe.setup_hint ? `\nSetup: ${recipe.setup_hint}` : '')
      );
      process.exit(1);
    }
    const firstModel = recipe.touchpoints.embedding?.models[0];
    if (!firstModel) {
      console.error(`Provider ${shorthand} has no embedding models listed. Use --embedding-model provider:model.`);
      process.exit(1);
    }
    out.embedding_model = `${shorthand}:${firstModel}`;
    out.embedding_dimensions = recipe.touchpoints.embedding!.default_dims;
  }

  if (dimsArg !== null && !Number.isNaN(dimsArg) && dimsArg > 0) {
    out.embedding_dimensions = dimsArg;
  } else if (out.embedding_model && out.embedding_dimensions === undefined) {
    // Derive default dims from the resolved recipe when verbose form was used.
    const { getRecipe } = await import('../core/ai/recipes/index.ts');
    const providerId = out.embedding_model.split(':')[0];
    const recipe = getRecipe(providerId);
    // v0.32: user_provided_models recipes (litellm, llama-server) have
    // default_dims=0 and ship with `models: []` — there's no sensible
    // fallback. Refuse explicitly here too. Without this, the verbose path
    // `--embedding-model llama-server:foo` (no --embedding-dimensions) would
    // fall through to configureGateway's default (1536), creating a
    // wrong-width schema that explodes only at first embed.
    if (recipe?.touchpoints.embedding?.user_provided_models === true) {
      console.error(
        `Provider ${providerId} requires --embedding-dimensions <N> when using --embedding-model ${out.embedding_model}.\n` +
        `User-driven-model recipes (litellm, llama-server) have no default dimension.\n` +
        (recipe.setup_hint ? `\nSetup: ${recipe.setup_hint}` : '')
      );
      process.exit(1);
    }
    if (recipe?.touchpoints.embedding?.default_dims) {
      out.embedding_dimensions = recipe.touchpoints.embedding.default_dims;
    }
  }

  if (expansion) out.expansion_model = expansion;
  if (chat) out.chat_model = chat;

  // --- D9: --no-embedding opt-in --------------------------------------------
  // Even when other flags were passed, --no-embedding signals "skip embedding
  // configuration entirely". Persist the explicit opt-in (T6/T7 use it).
  if (noEmbedding) {
    out.noEmbedding = true;
    // Wipe any tentative embedding settings — opt-in means truly nothing.
    delete out.embedding_model;
    delete out.embedding_dimensions;
  }

  // --- Tier 3: env detection ------------------------------------------------
  // Fires per touchpoint, only when no explicit flag was passed for that
  // tier. Embedding is the critical path (column width); chat/expansion are
  // best-effort (gateway falls back gracefully at call time, D10).

  if (!out.noEmbedding && !out.embedding_model) {
    await resolveEmbeddingByEnv(out, nonInteractive);
  }
  if (!out.expansion_model) {
    await resolveExpansionByEnv(out);
  }
  if (!out.chat_model) {
    await resolveChatByEnv(out);
  }

  return out;
}

// ============================================================================
// v0.37 env-detection helpers (T5)
//
// These run when no explicit flag is passed for the corresponding touchpoint.
// They share `groupReadyByProvider` so the per-touchpoint surface stays
// consistent (codex finding #2: group by provider id, not by recipe, so two
// recipes sharing OPENAI_API_KEY can't double-count).
// ============================================================================

interface ReadyProvider {
  recipeId: string;
  recipe: import('../core/ai/types.ts').Recipe;
}

/**
 * Walk recipes and return providers env-ready for the given touchpoint.
 * Exported for unit tests (parameterizable via env arg).
 *
 * Excludes local-only providers (no auth_env.required, e.g. Ollama,
 * llama-server) from auto-pick UNLESS they're the only thing available.
 * Picking Ollama silently when the user has OPENAI_API_KEY set is a
 * silent-broken-state class (Ollama daemon may not be running, or the
 * user clearly intended a hosted provider). Local-only providers stay
 * accessible via explicit `--embedding-model ollama:...`.
 */
export async function groupReadyByProvider(
  touchpoint: 'embedding' | 'expansion' | 'chat',
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReadyProvider[]> {
  const { listRecipes } = await import('../core/ai/recipes/index.ts');
  const { envReady } = await import('./providers.ts');
  const ready: ReadyProvider[] = [];
  const seen = new Set<string>();
  for (const r of listRecipes()) {
    if (seen.has(r.id)) continue;
    const tp = r.touchpoints[touchpoint];
    if (!tp) continue;
    // Skip recipes that ship without any models (user_provided_models flag,
    // e.g. litellm-proxy, llama-server). The shorthand --model path errors
    // for these; auto-pick should too.
    const tpModels = (tp as { models?: string[] }).models;
    if (!Array.isArray(tpModels) || tpModels.length === 0) continue;
    // Skip recipes whose user_provided_models flag is set even when models[]
    // has entries (defensive — shouldn't happen but cheap).
    if ((tp as { user_provided_models?: boolean }).user_provided_models) continue;
    // Skip local-only providers (no auth required) from auto-pick. They're
    // still picker-selectable explicitly, but silent auto-pick is wrong UX.
    const required = r.auth_env?.required ?? [];
    if (required.length === 0) continue;
    if (envReady(r, env)) {
      ready.push({ recipeId: r.id, recipe: r });
      seen.add(r.id);
    }
  }
  return ready;
}

/** Look at env-vars the user set that look like typos of recipe-required keys.
 *  Exported for unit tests (parameterizable via env arg). */
export async function findEnvKeyTypos(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Array<{ userSet: string; suggested: string }>> {
  const { suggestNearest } = await import('../core/levenshtein.ts');
  const { listRecipes } = await import('../core/ai/recipes/index.ts');
  // Build the canonical name set from every recipe's auth_env.required.
  const canonical = new Set<string>();
  for (const r of listRecipes()) {
    for (const k of r.auth_env?.required ?? []) canonical.add(k);
  }
  const out: Array<{ userSet: string; suggested: string }> = [];
  // Walk user env vars that look API-key-shaped to keep the suggestion noise low.
  const KEY_SHAPE = /^[A-Z][A-Z0-9_]*_(API_)?KEY$/;
  for (const userKey of Object.keys(env)) {
    if (!KEY_SHAPE.test(userKey)) continue;
    if (canonical.has(userKey)) continue;        // exact match, not a typo
    if (!env[userKey]) continue;                  // empty string, skip
    const suggestion = suggestNearest(userKey, [...canonical], /* maxDistance */ 3);
    if (suggestion && suggestion !== userKey) {
      // False-positive guard (per plan D13): suggested canonical not ALSO set.
      if (!env[suggestion]) {
        out.push({ userSet: userKey, suggested: suggestion });
      }
    }
  }
  return out;
}

/** Emit the fail-loud "no embedding provider" message + paste-ready setup. */
function printNoEmbeddingProviderHint(typos: Array<{ userSet: string; suggested: string }>): void {
  console.error('\nNo embedding provider configured. Set one of:');
  console.error('  export OPENAI_API_KEY=sk-…        # openai:text-embedding-3-large (1536d)');
  console.error('  export ZEROENTROPY_API_KEY=ze-…   # zeroentropyai:zembed-1 (2560d, Matryoshka)');
  console.error('  export VOYAGE_API_KEY=pa-…        # voyage:voyage-3-large (1024d)');
  console.error('Then re-run: gbrain init --pglite');
  console.error('');
  console.error('Or pick explicitly:');
  console.error('  gbrain init --pglite --embedding-model openai:text-embedding-3-large');
  console.error('');
  console.error('Or defer setup: gbrain init --pglite --no-embedding');
  console.error('  (you can configure later with `gbrain config set embedding_model <id>`)');
  // D13: surface near-miss env vars (e.g. OPENAPI_API_KEY → OPENAI_API_KEY).
  if (typos.length > 0) {
    console.error('');
    for (const t of typos) {
      console.error(`Note: detected ${t.userSet}; did you mean ${t.suggested}?`);
    }
  }
}

async function resolveEmbeddingByEnv(out: ResolvedAIOptions, nonInteractive: boolean): Promise<void> {
  const ready = await groupReadyByProvider('embedding');
  const isTTY = !nonInteractive && !!process.stdin.isTTY;

  if (ready.length === 1) {
    const r = ready[0].recipe;
    const tp = r.touchpoints.embedding!;
    if (Array.isArray(tp.models) && tp.models.length > 0) {
      const model = tp.models[0];
      const fullModel = `${r.id}:${model}`;
      // When the resolved provider matches the canonical default model
      // (DEFAULT_EMBEDDING_MODEL), use the gateway's
      // DEFAULT_EMBEDDING_DIMENSIONS instead of the recipe's `default_dims`
      // (which is the recipe's "largest sensible" tier). This keeps
      // fresh-install schema width aligned with the v0.37.11.0 system
      // default — for ZE that means 1280 (the Matryoshka step closest to
      // legacy OpenAI 1536), not the recipe's 2560.
      const { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSIONS } =
        await import('../core/ai/defaults.ts');
      const dims = fullModel === DEFAULT_EMBEDDING_MODEL
        ? DEFAULT_EMBEDDING_DIMENSIONS
        : tp.default_dims;
      out.embedding_model = fullModel;
      out.embedding_dimensions = dims;
      console.error(
        `Detected ${r.auth_env?.required?.[0] ?? r.id} env var. ` +
        `Using ${fullModel} (${dims}d). ` +
        `Override with --embedding-model.`,
      );
      return;
    }
  }

  // Zero or multi — pick or fail loud.
  if (ready.length === 0) {
    if (!isTTY) {
      const typos = await findEnvKeyTypos();
      printNoEmbeddingProviderHint(typos);
      process.exit(1);
    }
    // TTY → picker; on null (user aborted) still fail loud.
    const { pickProvider } = await import('./init-provider-picker.ts');
    const picked = await pickProvider({ touchpoint: 'embedding', env: process.env, isTTY: true });
    if (!picked) {
      const typos = await findEnvKeyTypos();
      printNoEmbeddingProviderHint(typos);
      process.exit(1);
    }
    out.embedding_model = picked.fullModel;
    out.embedding_dimensions = picked.dim;
    return;
  }

  // ready.length > 1 — picker (TTY) or fail-loud (non-TTY) per D2/D3.
  if (!isTTY) {
    console.error(`Multiple embedding providers env-ready: ${ready.map(p => p.recipeId).join(', ')}.`);
    console.error(`Disambiguate by passing --embedding-model <provider>:<model>, or unset extra env vars.`);
    process.exit(1);
  }
  const { pickProvider } = await import('./init-provider-picker.ts');
  const picked = await pickProvider({ touchpoint: 'embedding', env: process.env, isTTY: true });
  if (!picked) {
    console.error('Init aborted: no embedding provider picked.');
    process.exit(1);
  }
  out.embedding_model = picked.fullModel;
  out.embedding_dimensions = picked.dim;
}

async function resolveExpansionByEnv(out: ResolvedAIOptions): Promise<void> {
  const ready = await groupReadyByProvider('expansion');
  // Per D10: chat/expansion fall through to gateway default when ambiguous.
  if (ready.length === 1) {
    const r = ready[0].recipe;
    const tp = r.touchpoints.expansion!;
    if (Array.isArray(tp.models) && tp.models.length > 0) {
      out.expansion_model = `${r.id}:${tp.models[0]}`;
      console.error(`Detected ${r.auth_env?.required?.[0] ?? r.id} env var. Using ${out.expansion_model} for expansion.`);
    }
  }
  // 0 or >1 → silent: gateway default (`anthropic:claude-haiku-4-5-…`) wins
  // and falls back gracefully at call time when key isn't set.
}

async function resolveChatByEnv(out: ResolvedAIOptions): Promise<void> {
  const ready = await groupReadyByProvider('chat');
  if (ready.length === 1) {
    const r = ready[0].recipe;
    const tp = r.touchpoints.chat!;
    if (Array.isArray(tp.models) && tp.models.length > 0) {
      out.chat_model = `${r.id}:${tp.models[0]}`;
      console.error(`Detected ${r.auth_env?.required?.[0] ?? r.id} env var. Using ${out.chat_model} for chat.`);
    }
  }
  // 0 or >1 → silent: gateway default (`anthropic:claude-sonnet-4-6`) wins.
  // The subagent enforcement at minions/queue.ts already routes subagent jobs
  // to Anthropic regardless of the chat_model setting (D7 caveat fires from
  // T6's initPGLite post-config branch when chat_model is non-Anthropic and
  // ANTHROPIC_API_KEY is missing).
}

/**
 * Apply the schema against the already-configured engine. No saveConfig.
 * No PGLite fallback when no config exists. Used by migration orchestrators
 * to bump an existing brain's schema to the latest version without
 * clobbering the user's chosen engine.
 */
async function initMigrateOnly(opts: { jsonOutput: boolean }) {
  // v0.41.37.0 #1605: delegate to the shared runMigrateOnlyCore so the CLI path
  // and the in-process migration-orchestrator path can't drift (single source
  // of truth for configureGateway-before-initSchema + the schema bring-up).
  const { runMigrateOnlyCore, MigrateOnlyError } = await import('./migrations/in-process.ts');
  try {
    const result = await runMigrateOnlyCore();
    if (opts.jsonOutput) {
      console.log(JSON.stringify({ status: 'success', engine: result.engine, mode: 'migrate-only' }));
    } else {
      console.log(`Schema up to date (engine: ${result.engine}).`);
    }
  } catch (e) {
    const isNoConfig = e instanceof MigrateOnlyError && e.message.startsWith('No brain configured');
    const msg = e instanceof Error ? e.message : String(e);
    if (opts.jsonOutput) {
      console.log(JSON.stringify({ status: 'error', reason: isNoConfig ? 'no_config' : 'migrate_failed', message: msg }));
    } else {
      console.error(msg);
    }
    process.exit(1);
  }
}

/**
 * `gbrain init --mcp-only` — thin-client setup. Writes a `remote_mcp` config
 * field, runs three pre-flight smokes (OAuth discovery, token round-trip,
 * MCP initialize), and never creates a local engine.
 *
 * Required flags (or env vars):
 *   --issuer-url <url>          (or GBRAIN_REMOTE_ISSUER_URL)
 *   --mcp-url <url>             (or GBRAIN_REMOTE_MCP_URL)
 *   --oauth-client-id <id>      (or GBRAIN_REMOTE_CLIENT_ID)
 *   --oauth-client-secret <s>   (or GBRAIN_REMOTE_CLIENT_SECRET; preferred)
 *
 * Re-run semantics: if a thin-client config already exists, --force overwrites;
 * otherwise refuses with a hint pointing at the existing mcp_url.
 */
async function initRemoteMcp(opts: {
  args: string[];
  jsonOutput: boolean;
  isForce: boolean;
  isNonInteractive: boolean;
}) {
  const { args, jsonOutput, isForce } = opts;
  const arg = (flag: string) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : null;
  };
  const issuerUrl = (arg('--issuer-url') ?? process.env.GBRAIN_REMOTE_ISSUER_URL ?? '').trim();
  const mcpUrl = (arg('--mcp-url') ?? process.env.GBRAIN_REMOTE_MCP_URL ?? '').trim();
  const clientId = (arg('--oauth-client-id') ?? process.env.GBRAIN_REMOTE_CLIENT_ID ?? '').trim();
  const clientSecret = (arg('--oauth-client-secret') ?? process.env.GBRAIN_REMOTE_CLIENT_SECRET ?? '').trim();

  function fail(reason: string, message: string, extra: Record<string, unknown> = {}): never {
    if (jsonOutput) {
      console.log(JSON.stringify({ status: 'error', reason, message, ...extra }));
    } else {
      console.error(message);
    }
    process.exit(1);
  }

  if (!issuerUrl) fail('missing_issuer_url', '--issuer-url is required (or set GBRAIN_REMOTE_ISSUER_URL). Example: --issuer-url https://brain-host.local:3001');
  if (!mcpUrl) fail('missing_mcp_url', '--mcp-url is required (or set GBRAIN_REMOTE_MCP_URL). Example: --mcp-url https://brain-host.local:3001/mcp');
  if (!clientId) fail('missing_client_id', '--oauth-client-id is required (or set GBRAIN_REMOTE_CLIENT_ID). Get it from `gbrain auth register-client` on the host.');
  if (!clientSecret) fail('missing_client_secret', '--oauth-client-secret is required (or set GBRAIN_REMOTE_CLIENT_SECRET). Get it from `gbrain auth register-client` on the host.');

  // Re-run guard for --mcp-only specifically: refuse without --force to
  // avoid silently rotating credentials on a working install.
  const existing = loadConfig();
  if (isThinClient(existing) && !isForce) {
    const prevUrl = existing!.remote_mcp!.mcp_url;
    fail(
      'thin_client_config_present',
      `Thin-client config already present at ${configPath()} (remote_mcp.mcp_url=${prevUrl}).\n` +
      `Re-running --mcp-only would overwrite. Use --force to refresh.`,
      { mcp_url: prevUrl },
    );
  }

  if (!jsonOutput) {
    console.log('Thin-client setup — running pre-flight smoke...');
    console.log(`  issuer: ${issuerUrl}`);
    console.log(`  mcp:    ${mcpUrl}`);
  }

  // 1. OAuth discovery
  const disco = await discoverOAuth(issuerUrl);
  if (!disco.ok) {
    fail(
      `discovery_${disco.reason}`,
      `Pre-flight failed: OAuth discovery on ${issuerUrl} — ${disco.message}\n` +
      `Hint: confirm the issuer_url, that the host is reachable, and that \`gbrain serve --http\` is running there.`,
      { detail: disco.message, ...(disco.status ? { status: disco.status } : {}) },
    );
  }
  if (!jsonOutput) console.log(`  ✓ OAuth discovery (token_endpoint=${disco.metadata.token_endpoint})`);

  // 2. Token round-trip
  const tokenRes = await mintClientCredentialsToken(disco.metadata.token_endpoint, clientId, clientSecret);
  if (!tokenRes.ok) {
    fail(
      `token_${tokenRes.reason}`,
      `Pre-flight failed: OAuth /token — ${tokenRes.message}\n` +
      `Hint: the host operator can run \`gbrain auth register-client <name> --grant-types client_credentials --scopes read,write,admin\` to mint fresh credentials.`,
      { detail: tokenRes.message, ...(tokenRes.status ? { status: tokenRes.status } : {}) },
    );
  }
  if (!jsonOutput) console.log(`  ✓ OAuth /token (${tokenRes.token.token_type ?? 'bearer'}, scope=${tokenRes.token.scope ?? 'unspecified'})`);

  // 3. MCP smoke
  const mcpRes = await smokeTestMcp(mcpUrl, tokenRes.token.access_token);
  if (!mcpRes.ok) {
    fail(
      `mcp_smoke_${mcpRes.reason}`,
      `Pre-flight failed: MCP initialize on ${mcpUrl} — ${mcpRes.message}\n` +
      `Hint: confirm \`mcp_url\` matches the path the host serves \`/mcp\` on (default: <issuer_url>/mcp).`,
      { detail: mcpRes.message, ...(mcpRes.status ? { status: mcpRes.status } : {}) },
    );
  }
  if (!jsonOutput) console.log(`  ✓ MCP initialize`);

  // 4. Persist config. Preserve any existing AI/storage/etc. fields on
  // the existing config — only overwrite remote_mcp + drop engine/database
  // fields if this install is converting from local-engine to thin-client.
  // For first-time setup, write a minimal config.
  const baseConfig: Partial<GBrainConfig> = existing
    ? { ...existing, database_url: undefined, database_path: undefined }
    : {};
  // engine field is required on the type; leave it inferred to 'postgres'
  // for default purposes — it's never used because the dispatch guard
  // short-circuits any DB-bound path before connectEngine.
  const config: GBrainConfig = {
    ...(baseConfig as GBrainConfig),
    engine: existing?.engine ?? 'postgres',
    remote_mcp: {
      issuer_url: issuerUrl.replace(/\/+$/, ''),
      mcp_url: mcpUrl,
      oauth_client_id: clientId,
      // Only persist the secret to disk if it didn't come from the env var.
      // Env-var-supplied secrets stay in env; on-disk copy is opt-in via
      // the --oauth-client-secret flag (or absent env var).
      ...(process.env.GBRAIN_REMOTE_CLIENT_SECRET === clientSecret
        ? {}
        : { oauth_client_secret: clientSecret }),
    },
  };
  // database_url / database_path get explicitly removed when converting; the
  // spread above with `undefined` doesn't drop them in JSON, so prune.
  const configRecord = config as unknown as Record<string, unknown>;
  delete configRecord.database_url;
  delete configRecord.database_path;
  saveConfig(config);

  if (jsonOutput) {
    console.log(JSON.stringify({
      status: 'success',
      mode: 'thin-client',
      issuer_url: config.remote_mcp!.issuer_url,
      mcp_url: config.remote_mcp!.mcp_url,
      oauth_client_id: config.remote_mcp!.oauth_client_id,
      oauth_secret_in_config: 'oauth_client_secret' in config.remote_mcp!,
    }));
  } else {
    console.log('');
    console.log('Thin-client mode configured. No local DB.');
    console.log(`  Config: ${configPath()}`);
    console.log(`  Talks to: ${config.remote_mcp!.mcp_url}`);
    console.log('');
    console.log('Next steps:');
    console.log(`  1. Configure your agent's MCP client to point at ${config.remote_mcp!.mcp_url} (Claude Desktop / Hermes / openclaw).`);
    console.log('  2. Run `gbrain doctor` to re-verify connectivity at any time.');
    console.log('  3. Run `gbrain remote ping` after writing markdown if you want the host to re-index immediately (Tier B).');
  }
}

/**
 * Configure the AI gateway with the merged precedence
 * `CLI flags > env > existing file > gateway internal defaults`, then read
 * back the resolved values so the caller can both print them and persist
 * them to config.json.
 *
 * v0.37 fix wave (Lane B.1/B.2/B.3): pre-fix, the gateway was only configured
 * when a flag was passed. Bare `gbrain init --pglite` left the gateway
 * unconfigured and engine.initSchema() fell through to stale OpenAI/1536
 * defaults — schema sized to 1536 while the ZE default emitted 1280. Now
 * the gateway is ALWAYS configured before initSchema; the schema matches
 * the resolved provider/dim out of the box.
 */
async function configureGatewayWithMergedPrecedence(
  aiOpts?: { embedding_model?: string; embedding_dimensions?: number; expansion_model?: string; chat_model?: string },
): Promise<{ embedding_model: string; embedding_dimensions: number; expansion_model: string; chat_model: string }> {
  const existingFile = loadConfigFileOnly() ?? ({} as GBrainConfig);
  // loadConfig() merges env on top of file — perfect for the gateway path,
  // where env should win over a stale file. NOT used for the save path
  // (see B.4), which uses loadConfigFileOnly so transient env state never
  // pollutes config.json.
  const envOverlay = loadConfig() ?? ({} as GBrainConfig);

  const merged = {
    embedding_model: aiOpts?.embedding_model ?? envOverlay.embedding_model ?? existingFile.embedding_model,
    embedding_dimensions: aiOpts?.embedding_dimensions ?? envOverlay.embedding_dimensions ?? existingFile.embedding_dimensions,
    expansion_model: aiOpts?.expansion_model ?? envOverlay.expansion_model ?? existingFile.expansion_model,
    chat_model: aiOpts?.chat_model ?? envOverlay.chat_model ?? existingFile.chat_model,
  };

  const { configureGateway, getEmbeddingModel, getEmbeddingDimensions, getExpansionModel, getChatModel } = await import('../core/ai/gateway.ts');
  configureGateway({
    embedding_model: merged.embedding_model,
    embedding_dimensions: merged.embedding_dimensions,
    expansion_model: merged.expansion_model,
    chat_model: merged.chat_model,
    env: { ...process.env },
  });

  // Read back resolved values — gateway applies internal defaults for unset
  // fields, so these are the values that actually shaped the schema.
  return {
    embedding_model: getEmbeddingModel(),
    embedding_dimensions: getEmbeddingDimensions(),
    expansion_model: getExpansionModel(),
    chat_model: getChatModel(),
  };
}

/**
 * Print the resolved AI choice + a ZE setup hint when applicable.
 */
function printResolvedAIChoice(
  resolved: { embedding_model: string; embedding_dimensions: number; expansion_model: string; chat_model: string },
  aiOpts?: { embedding_model?: string },
) {
  const explicit = aiOpts?.embedding_model != null;
  const label = explicit ? '' : ' [default]';
  console.log(`  Embedding: ${resolved.embedding_model} (${resolved.embedding_dimensions}d)${label}`);
  console.log(`  Expansion: ${resolved.expansion_model}`);
  console.log(`  Chat:      ${resolved.chat_model}`);

  // ZE setup hint: if resolved provider is ZE and no ZE key is set in env
  // OR in the file plane, surface the setup gap at init time instead of
  // letting the first embed call blow up. After Lane C, file-plane
  // zeroentropy_api_key propagates through buildGatewayConfig.
  if (resolved.embedding_model.startsWith('zeroentropyai:')) {
    const fileCfg = loadConfigFileOnly();
    if (!process.env.ZEROENTROPY_API_KEY && !fileCfg?.zeroentropy_api_key) {
      console.warn('');
      console.warn('  Heads up: ZEROENTROPY_API_KEY is not set.');
      console.warn('  Set it before first embed:');
      console.warn('    export ZEROENTROPY_API_KEY=...');
      console.warn('  Or add to ~/.gbrain/config.json:');
      console.warn('    "zeroentropy_api_key": "..."');
      console.warn('  Or pick a different provider:');
      console.warn('    gbrain init --pglite --embedding-model openai:text-embedding-3-large --embedding-dimensions 1536');
    }
  }
}

async function initPGLite(opts: {
  jsonOutput: boolean;
  apiKey: string | null;
  customPath: string | null;
  aiOpts?: ResolvedAIOptions;
  /** v0.42 (T17): schema pack to default. Stored as config.schema_pack
   *  so loadActivePack's homeConfig tier resolves it. */
  schemaPack?: string;
}) {
  const dbPath = opts.customPath || gbrainPath('brain.pglite');
  console.log(`Setting up local brain with PGLite (no server needed)...`);

  // v0.37.10.0 T6 (D11): preflight schema dim BEFORE any DB write or schema
  // creation. After T5's env detection runs, opts.aiOpts has either an
  // embedding_model resolved (auto-pick / picker / explicit flag) OR
  // noEmbedding=true (D9 opt-in). Either way we MUST agree with the
  // gateway's resolved dim by construction — preflight validates that.
  let resolvedDim: number | undefined;
  let resolvedModel: string | undefined;
  if (opts.aiOpts?.noEmbedding) {
    // D9 deferred-setup mode: skip preflight, no model/dim resolved.
    console.log(`  --no-embedding: deferred setup — configure with \`gbrain config set embedding_model <id>\` before import`);
  } else if (opts.aiOpts?.embedding_model) {
    const { resolveSchemaEmbeddingDim } = await import('../core/embedding-dim-check.ts');
    const pre = resolveSchemaEmbeddingDim({
      embedding_model: opts.aiOpts.embedding_model,
      embedding_dimensions: opts.aiOpts.embedding_dimensions,
    });
    if (!pre.ok) {
      console.error(`\nRefusing to init: ${pre.error}\n`);
      if (opts.jsonOutput) {
        console.log(JSON.stringify({ status: 'error', reason: 'preflight_failed', error: pre.error }));
      }
      process.exit(1);
    }
    resolvedDim = pre.dim;
    resolvedModel = pre.model;
  }
  // If neither --no-embedding nor an embedding_model is resolved, resolveAIOptions
  // already exited 1 with the fail-loud setup hint (T5). Reaching here without
  // either means we have a user-passed combination the previous step accepted —
  // typically `--embedding-model` flag without env detection running.

  // v0.37.10.0 T6 + v0.37.11.0 Lane B.1: ALWAYS configureGateway BEFORE
  // initSchema. Schema substitution at pglite-schema.ts:833 and the runtime
  // gateway share one source of truth. Resolution precedence locked in
  // resolveAIOptions above: CLI flags > env vars > existing file > gateway
  // defaults.
  const { configureGateway } = await import('../core/ai/gateway.ts');
  configureGateway({
    embedding_model: resolvedModel ?? opts.aiOpts?.embedding_model,
    embedding_dimensions: resolvedDim ?? opts.aiOpts?.embedding_dimensions,
    expansion_model: opts.aiOpts?.expansion_model,
    chat_model: opts.aiOpts?.chat_model,
    env: { ...process.env },
  });
  if (resolvedModel) console.log(`  Embedding: ${resolvedModel} (${resolvedDim}d)`);
  if (opts.aiOpts?.expansion_model) console.log(`  Expansion: ${opts.aiOpts.expansion_model}`);
  if (opts.aiOpts?.chat_model) console.log(`  Chat: ${opts.aiOpts.chat_model}`);

  // v0.37.11.0 Lane C.3: surface ZE setup gap inline at init time when the
  // resolved provider is ZeroEntropy and neither env nor file-plane key is
  // set. Beats "first embed call blows up four minutes later" UX.
  if (resolvedModel?.startsWith('zeroentropyai:')) {
    const fileCfg = loadConfigFileOnly();
    if (!process.env.ZEROENTROPY_API_KEY && !fileCfg?.zeroentropy_api_key) {
      console.warn('');
      console.warn('  Heads up: ZEROENTROPY_API_KEY is not set.');
      console.warn('  Set it before first embed:');
      console.warn('    export ZEROENTROPY_API_KEY=...');
      console.warn('  Or add to ~/.gbrain/config.json:');
      console.warn('    "zeroentropy_api_key": "..."');
      console.warn('  Or pick a different provider:');
      console.warn('    gbrain init --pglite --embedding-model openai:text-embedding-3-large --embedding-dimensions 1536');
    }
  }

  const engine = await createEngine({ engine: 'pglite' });
  try {
    await engine.connect({ database_path: dbPath, engine: 'pglite' });

    // v0.28.5 (A4) + v0.37.11.0 Lane B.5: refuse to silently re-template an
    // existing brain with a mismatched embedding dimension. Catches both the
    // explicit-flag case (v0.28.5) AND the bare-init case where a user with
    // a 1536 brain runs `gbrain init --pglite` after upgrading to v0.36+
    // and would silently end up with runtime ZE/1280 against a 1536 column
    // (Lane B.5). Fresh-install case is now structurally impossible after
    // v0.37.10.0 T6's preflight.
    if (resolvedDim) {
      const { readContentChunksEmbeddingDim, embeddingMismatchMessage } = await import('../core/embedding-dim-check.ts');
      const existing = await readContentChunksEmbeddingDim(engine);
      if (existing.exists && existing.dims !== null && existing.dims !== resolvedDim) {
        console.error('\n' + embeddingMismatchMessage({
          currentDims: existing.dims,
          requestedDims: resolvedDim,
          requestedModel: resolvedModel,
          source: 'init',
          engineKind: 'pglite',
          databasePath: dbPath,
        }) + '\n');
        if (opts.jsonOutput) {
          console.log(JSON.stringify({
            status: 'error',
            reason: 'embedding_dim_mismatch',
            current_dims: existing.dims,
            requested_dims: resolvedDim,
          }));
        }
        process.exit(1);
      }
    }

    await engine.initSchema();

    // v0.37.10.0 T6 (D11): post-initSchema invariant assertion. After preflight
    // + always-configureGateway, this is structurally guaranteed to pass —
    // kept as a regression guardrail so any future schema-substitution drift
    // fails loud here, not at first embed.
    if (resolvedDim) {
      const { readContentChunksEmbeddingDim, embeddingMismatchMessage } = await import('../core/embedding-dim-check.ts');
      const after = await readContentChunksEmbeddingDim(engine);
      if (after.exists && after.dims !== null && after.dims !== resolvedDim) {
        console.error('\nUNEXPECTED: post-initSchema invariant assertion failed.');
        console.error('  This is a bug. Please file an issue with the output of `gbrain doctor`.\n');
        console.error(embeddingMismatchMessage({
          currentDims: after.dims,
          requestedDims: resolvedDim,
          requestedModel: resolvedModel,
          source: 'init',
          engineKind: 'pglite',
          databasePath: dbPath,
        }));
        process.exit(1);
      }
    }

    // v0.37.10.0 T7 (D9) + v0.37.11.0 Lane B.4: atomic embedding-config
    // persistence on top of the existing file-plane config (preserves
    // user-set fields like zeroentropy_api_key, chat_model, expansion_model).
    // Either the deferred-setup sentinel (`embedding_disabled: true`) OR the
    // resolved (model, dimensions) tuple. Never a partial state. Precedence:
    // CLI flags this invocation > existing file plane > resolved defaults.
    // Use loadConfigFileOnly() — loadConfig() would poison config.json with
    // any DATABASE_URL the current process happens to have set (CDX2-7).
    const existingFile = loadConfigFileOnly() ?? ({} as GBrainConfig);
    const config: GBrainConfig = {
      ...existingFile,
      engine: 'pglite',
      database_path: dbPath,
      ...(opts.apiKey ? { openai_api_key: opts.apiKey } : {}),
      ...(opts.aiOpts?.noEmbedding
        ? { embedding_disabled: true }
        : (resolvedModel && resolvedDim)
          ? { embedding_model: resolvedModel, embedding_dimensions: resolvedDim }
          : {}),
      ...(opts.aiOpts?.expansion_model ? { expansion_model: opts.aiOpts.expansion_model } : {}),
      ...(opts.aiOpts?.chat_model ? { chat_model: opts.aiOpts.chat_model } : {}),
      // v0.42 (T17): default new brains to the schema_pack selected at init
      // time. Existing config.schema_pack survives (...existingFile spread)
      // unless explicitly overridden by --schema-pack on re-init.
      ...(opts.schemaPack ? { schema_pack: opts.schemaPack } : {}),
    };
    // PR1: new installs publish their skill catalog over MCP by default
    // (existing config wins on re-init, so a prior opt-out is preserved).
    config.mcp = { publish_skills: true, ...(config.mcp ?? {}) };
    saveConfig(config);
    if (opts.schemaPack) {
      process.stderr.write(
        `[init] Using schema pack: ${opts.schemaPack} (override with --schema-pack <name>)\n`,
      );
    }

    // T6 (D7): post-init subagent-Anthropic caveat. Fires for both auto-pick
    // and picker paths so users see the implication of running on a chat
    // provider that can't drive the subagent loop.
    if (opts.aiOpts?.chat_model && !opts.aiOpts.chat_model.startsWith('anthropic:') && !process.env.ANTHROPIC_API_KEY) {
      const { printSubagentAnthropicCaveat } = await import('./init-provider-picker.ts');
      printSubagentAnthropicCaveat((s) => process.stderr.write(s));
    }

    // v0.32.3 search-lite install-time mode picker. Runs AFTER initSchema so
    // DB config writes are valid. Idempotent: skipped on re-init if already set.
    // Non-TTY auto-selects; --json emits a structured event.
    const { runModePicker } = await import('./init-mode-picker.ts');
    await runModePicker(engine, { jsonOutput: opts.jsonOutput });

    const stats = await engine.getStats();

    if (opts.jsonOutput) {
      console.log(JSON.stringify({ status: 'success', engine: 'pglite', path: dbPath, pages: stats.page_count }));
    } else {
      console.log(`\nBrain ready at ${dbPath}`);
      console.log(`${stats.page_count} pages. Engine: PGLite (local Postgres).`);
      if (stats.page_count > 0) {
        console.log('');
        console.log('Existing brain detected. To wire up the v0.10.3 knowledge graph:');
        console.log('  gbrain extract links --source db        (typed link backfill)');
        console.log('  gbrain extract timeline --source db     (structured timeline backfill)');
        console.log('  gbrain stats                            (verify links > 0)');
      } else {
        console.log('Next: gbrain import <dir>');
      }
      console.log('');
      console.log('When you outgrow local: gbrain migrate --to supabase');
      reportModStatus();
      const { printAdvisoryIfRecommended } = await import('../core/skillpack/post-install-advisory.ts');
      const { VERSION } = await import('../version.ts');
      printAdvisoryIfRecommended({ version: VERSION, context: 'init' });

      // v0.41.18.0 (A4 + A18 + A20, T14): post-initSchema onboard nudge.
      // Fail-open; 3s wallclock cap. Skipped silently in non-TTY contexts.
      const { runInitNudge } = await import('../core/onboard/init-nudge.ts');
      await runInitNudge(engine);
    }
  } finally {
    try { await engine.disconnect(); } catch { /* best-effort */ }
  }
}

async function initPostgres(opts: {
  databaseUrl: string;
  jsonOutput: boolean;
  apiKey: string | null;
  aiOpts?: ResolvedAIOptions;
  /** v0.42 (T17): schema pack to default. */
  schemaPack?: string;
}) {
  const { databaseUrl } = opts;

  // v0.37.10.0 T6 (D11) + v0.37.11.0 Lane B.2: ALWAYS configure gateway BEFORE
  // initSchema. Same preflight contract as PGLite. Refuse to call initSchema
  // until the gateway-resolved dim is validated. Schema substitution in
  // src/schema.sql is currently a static `vector(1536)` for Postgres (unlike
  // PGLite's templated dim), so a Voyage/ZE-configured Postgres brain will
  // still need a future schema rewrite path — preflight makes the
  // not-yet-supported case fail loud rather than silently produce a stuck
  // 1536d column.
  let resolvedDim: number | undefined;
  let resolvedModel: string | undefined;
  if (opts.aiOpts?.noEmbedding) {
    console.log(`  --no-embedding: deferred setup — configure with \`gbrain config set embedding_model <id>\` before import`);
  } else if (opts.aiOpts?.embedding_model) {
    const { resolveSchemaEmbeddingDim } = await import('../core/embedding-dim-check.ts');
    const pre = resolveSchemaEmbeddingDim({
      embedding_model: opts.aiOpts.embedding_model,
      embedding_dimensions: opts.aiOpts.embedding_dimensions,
    });
    if (!pre.ok) {
      console.error(`\nRefusing to init: ${pre.error}\n`);
      if (opts.jsonOutput) {
        console.log(JSON.stringify({ status: 'error', reason: 'preflight_failed', error: pre.error }));
      }
      process.exit(1);
    }
    resolvedDim = pre.dim;
    resolvedModel = pre.model;
  }

  // T6: unconditional configureGateway BEFORE initSchema.
  const { configureGateway } = await import('../core/ai/gateway.ts');
  configureGateway({
    embedding_model: resolvedModel ?? opts.aiOpts?.embedding_model,
    embedding_dimensions: resolvedDim ?? opts.aiOpts?.embedding_dimensions,
    expansion_model: opts.aiOpts?.expansion_model,
    chat_model: opts.aiOpts?.chat_model,
    env: { ...process.env },
  });
  if (resolvedModel) console.log(`  Embedding: ${resolvedModel} (${resolvedDim}d)`);
  if (opts.aiOpts?.expansion_model) console.log(`  Expansion: ${opts.aiOpts.expansion_model}`);
  if (opts.aiOpts?.chat_model) console.log(`  Chat: ${opts.aiOpts.chat_model}`);

  // v0.37.11.0 Lane C.3: surface ZE setup gap inline at init time when the
  // resolved provider is ZeroEntropy and neither env nor file-plane key is
  // set. Beats "first embed call blows up four minutes later" UX.
  if (resolvedModel?.startsWith('zeroentropyai:')) {
    const fileCfg = loadConfigFileOnly();
    if (!process.env.ZEROENTROPY_API_KEY && !fileCfg?.zeroentropy_api_key) {
      console.warn('');
      console.warn('  Heads up: ZEROENTROPY_API_KEY is not set.');
      console.warn('  Set it before first embed:');
      console.warn('    export ZEROENTROPY_API_KEY=...');
      console.warn('  Or add to ~/.gbrain/config.json:');
      console.warn('    "zeroentropy_api_key": "..."');
      console.warn('  Or pick a different provider:');
      console.warn('    gbrain init --pglite --embedding-model openai:text-embedding-3-large --embedding-dimensions 1536');
    }
  }

  // Detect Supabase direct connection URLs and warn about IPv6
  if (databaseUrl.match(/db\.[a-z]+\.supabase\.co/) || databaseUrl.includes('.supabase.co:5432')) {
    console.warn('');
    console.warn('WARNING: You provided a Supabase direct connection URL (db.*.supabase.co:5432).');
    console.warn('  Direct connections are IPv6 only and fail in many environments.');
    console.warn('  Use the Session pooler connection string instead (port 6543):');
    console.warn('  Supabase Dashboard > gear icon (Project Settings) > Database >');
    console.warn('  Connection string > URI tab > change dropdown to "Session pooler"');
    console.warn('');
  }

  console.log('Connecting to database...');
  const engine = await createEngine({ engine: 'postgres' });
  try {
    try {
      await engine.connect({ database_url: databaseUrl });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (databaseUrl.includes('supabase.co') && (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT'))) {
        console.error('Connection failed. Supabase direct connections (db.*.supabase.co:5432) are IPv6 only.');
        console.error('Use the Session pooler connection string instead (port 6543).');
      }
      throw e;
    }

    // Check and auto-create pgvector extension
    try {
      const conn = (engine as any).sql || (await import('../core/db.ts')).getConnection();
      const ext = await conn`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
      if (ext.length === 0) {
        console.log('pgvector extension not found. Attempting to create...');
        try {
          await conn`CREATE EXTENSION IF NOT EXISTS vector`;
          console.log('pgvector extension created successfully.');
        } catch {
          console.error('Could not auto-create pgvector extension. Run manually in SQL Editor:');
          console.error('  CREATE EXTENSION vector;');
          // Throw so the outer finally runs engine.disconnect() before we die.
          throw new Error('pgvector extension missing');
        }
      }
    } catch {
      // Non-fatal
    }

    // v0.28.5 (A4) + v0.37.11.0 Lane B.5: refuse to silently re-template an
    // existing brain with a mismatched embedding dimension. Mirror of the
    // PGLite path above. Fires even when the user didn't pass
    // `--embedding-dimensions` explicitly so the Lane B.5 bare-init case is
    // covered too.
    if (resolvedDim) {
      const { readContentChunksEmbeddingDim, embeddingMismatchMessage } = await import('../core/embedding-dim-check.ts');
      const existing = await readContentChunksEmbeddingDim(engine);
      if (existing.exists && existing.dims !== null && existing.dims !== resolvedDim) {
        console.error('\n' + embeddingMismatchMessage({
          currentDims: existing.dims,
          requestedDims: resolvedDim,
          requestedModel: resolvedModel,
          source: 'init',
          engineKind: 'postgres',
        }) + '\n');
        if (opts.jsonOutput) {
          console.log(JSON.stringify({
            status: 'error',
            reason: 'embedding_dim_mismatch',
            current_dims: existing.dims,
            requested_dims: resolvedDim,
          }));
        }
        process.exit(1);
      }
    }

    console.log('Running schema migration...');
    await engine.initSchema();

    // v0.37.10.0 T6 (D11): post-initSchema invariant assertion guardrail.
    if (resolvedDim) {
      const { readContentChunksEmbeddingDim, embeddingMismatchMessage } = await import('../core/embedding-dim-check.ts');
      const after = await readContentChunksEmbeddingDim(engine);
      if (after.exists && after.dims !== null && after.dims !== resolvedDim) {
        console.error('\nUNEXPECTED: post-initSchema invariant assertion failed.');
        console.error('  This is a bug. Please file an issue with the output of `gbrain doctor`.\n');
        console.error(embeddingMismatchMessage({
          currentDims: after.dims,
          requestedDims: resolvedDim,
          requestedModel: resolvedModel,
          source: 'init',
          engineKind: 'postgres',
        }));
        process.exit(1);
      }
    }

    // v0.37.10.0 T7 (D9) + v0.37.11.0 Lane B.4 (Postgres mirror): atomic
    // embedding-config persistence on top of the existing file-plane config.
    // Same precedence + same merge contract as the PGLite path above.
    const existingFile = loadConfigFileOnly() ?? ({} as GBrainConfig);
    const config: GBrainConfig = {
      ...existingFile,
      engine: 'postgres',
      database_url: databaseUrl,
      database_path: undefined, // clear any stale PGLite path
      ...(opts.apiKey ? { openai_api_key: opts.apiKey } : {}),
      ...(opts.aiOpts?.noEmbedding
        ? { embedding_disabled: true }
        : (resolvedModel && resolvedDim)
          ? { embedding_model: resolvedModel, embedding_dimensions: resolvedDim }
          : {}),
      ...(opts.aiOpts?.expansion_model ? { expansion_model: opts.aiOpts.expansion_model } : {}),
      ...(opts.aiOpts?.chat_model ? { chat_model: opts.aiOpts.chat_model } : {}),
      // v0.42 (T17): same schema_pack default as PGLite path.
      ...(opts.schemaPack ? { schema_pack: opts.schemaPack } : {}),
    };
    // PR1: new installs publish their skill catalog over MCP by default
    // (existing config wins on re-init, so a prior opt-out is preserved).
    config.mcp = { publish_skills: true, ...(config.mcp ?? {}) };
    saveConfig(config);
    console.log('Config saved to ~/.gbrain/config.json');
    if (opts.schemaPack) {
      process.stderr.write(
        `[init] Using schema pack: ${opts.schemaPack} (override with --schema-pack <name>)\n`,
      );
    }

    // T6 (D7): post-init subagent-Anthropic caveat.
    if (opts.aiOpts?.chat_model && !opts.aiOpts.chat_model.startsWith('anthropic:') && !process.env.ANTHROPIC_API_KEY) {
      const { printSubagentAnthropicCaveat } = await import('./init-provider-picker.ts');
      printSubagentAnthropicCaveat((s) => process.stderr.write(s));
    }

    // v0.32.3 search-lite install-time mode picker. Same shape as the
    // PGLite path above — runs AFTER initSchema, idempotent on re-init.
    const { runModePicker: runPostgresModePicker } = await import('./init-mode-picker.ts');
    await runPostgresModePicker(engine, { jsonOutput: opts.jsonOutput });

    const stats = await engine.getStats();

    if (opts.jsonOutput) {
      console.log(JSON.stringify({ status: 'success', engine: 'postgres', pages: stats.page_count }));
    } else {
      console.log(`\nBrain ready. ${stats.page_count} pages. Engine: Postgres (Supabase).`);
      if (stats.page_count > 0) {
        console.log('');
        console.log('Existing brain detected. To wire up the v0.10.3 knowledge graph:');
        console.log('  gbrain extract links --source db        (typed link backfill)');
        console.log('  gbrain extract timeline --source db     (structured timeline backfill)');
        console.log('  gbrain stats                            (verify links > 0)');
      } else {
        console.log('Next: gbrain import <dir>');
      }
      reportModStatus();
      const { printAdvisoryIfRecommended } = await import('../core/skillpack/post-install-advisory.ts');
      const { VERSION } = await import('../version.ts');
      printAdvisoryIfRecommended({ version: VERSION, context: 'init' });

      // v0.41.18.0 (A4 + A18 + A20, T14): post-initSchema onboard nudge.
      // Fail-open; 3s wallclock cap. Skipped silently in non-TTY contexts.
      const { runInitNudge } = await import('../core/onboard/init-nudge.ts');
      await runInitNudge(engine);
    }
  } finally {
    try { await engine.disconnect(); } catch { /* best-effort */ }
  }
}

/**
 * Quick count of .md files in a directory (stops early at 1000).
 */
function countMarkdownFiles(dir: string, maxScan = 1500): number {
  let count = 0;
  try {
    const scan = (d: string) => {
      if (count >= maxScan) return;
      for (const entry of readdirSync(d)) {
        if (count >= maxScan) return;
        if (entry.startsWith('.') || entry === 'node_modules') continue;
        const full = join(d, entry);
        try {
          let stat;
          try {
            stat = lstatSync(full);
          } catch { continue; }
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) scan(full);
          else if (entry.endsWith('.md')) count++;
        } catch { /* skip unreadable */ }
      }
    };
    scan(dir);
  } catch { /* skip unreadable root */ }
  return count;
}

async function supabaseWizard(): Promise<string> {
  try {
    execSync('bunx supabase --version', { stdio: 'pipe' });
    console.log('Supabase CLI detected.');
    console.log('To auto-provision, run: bunx supabase login && bunx supabase projects create');
    console.log('Then use: gbrain init --url <your-connection-string>');
  } catch {
    console.log('Supabase CLI not found.');
  }

  console.log('\nEnter your Supabase/Postgres connection URL:');
  console.log('  Format: postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres'); /* allow-pg-url-literal */
  console.log('  Find it: Supabase Dashboard > Connect (top bar) > Connection String > Session Pooler\n');

  const url = await readLine('Connection URL: ');
  if (!url) {
    console.error('No URL provided.');
    process.exit(1);
  }
  return url;
}

function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.once('data', (chunk) => {
      data = chunk.toString().trim();
      process.stdin.pause();
      resolve(data);
    });
    process.stdin.resume();
  });
}

/**
 * v0.32.3 [CDX-9]: readLine + EOF detection + default fallback + timeout.
 *
 * The legacy readLine hangs forever if stdin closes (EOF mid-prompt) or
 * the user never types anything. The mode-picker plan calls out "TTY
 * closes mid-prompt → defaults to balanced" as a failure path, but the
 * raw helper can't implement that contract.
 *
 * This wrapper:
 *   - Resolves to `defaultValue` if stdin emits 'end' before 'data'
 *   - Resolves to `defaultValue` if `timeoutMs` elapses with no input
 *   - Resolves to the typed value (trimmed) on normal data event
 *
 * `defaultValue` is returned VERBATIM when the user just hits Enter (empty
 * data). That's the affordance that makes `Mode [balanced]: _` work.
 *
 * Non-TTY stdin (pipe, scripted init) returns defaultValue immediately
 * without printing the prompt, so e2e tests don't hang.
 */
export function readLineSafe(
  prompt: string,
  defaultValue: string,
  timeoutMs: number = 60_000,
): Promise<string> {
  return new Promise((resolve) => {
    // Non-TTY (pipe, redirect, scripted init) → no prompt, no wait.
    if (!process.stdin.isTTY) {
      resolve(defaultValue);
      return;
    }

    process.stdout.write(prompt);
    process.stdin.setEncoding('utf-8');

    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      try { process.stdin.pause(); } catch { /* swallow */ }
      resolve(value);
    };

    const onData = (chunk: Buffer | string) => {
      const raw = chunk.toString().trim();
      finish(raw.length === 0 ? defaultValue : raw);
    };
    const onEnd = () => finish(defaultValue);

    const timer = setTimeout(() => {
      process.stdout.write(`\n[timeout after ${Math.round(timeoutMs / 1000)}s, using default: ${defaultValue}]\n`);
      finish(defaultValue);
    }, timeoutMs);

    process.stdin.once('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.resume();
  });
}

/**
 * Detect GStack installation across known host paths.
 * Uses gstack-global-discover if available, falls back to path checking.
 */
export function detectGStack(): { found: boolean; path: string | null; host: string | null } {
  // Try gstack's own discovery tool first (DRY: don't reimplement host detection)
  try {
    const result = execSync(
      `${join(homedir(), '.claude', 'skills', 'gstack', 'bin', 'gstack-global-discover')} 2>/dev/null`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    if (result) {
      return { found: true, path: result.split('\n')[0], host: 'auto-detected' };
    }
  } catch { /* binary not available */ }

  // Fallback: check known host paths
  const hostPaths = [
    { path: join(homedir(), '.claude', 'skills', 'gstack'), host: 'claude' },
    { path: join(homedir(), '.openclaw', 'skills', 'gstack'), host: 'openclaw' },
    { path: join(homedir(), '.codex', 'skills', 'gstack'), host: 'codex' },
    { path: join(homedir(), '.factory', 'skills', 'gstack'), host: 'factory' },
    { path: join(homedir(), '.kiro', 'skills', 'gstack'), host: 'kiro' },
  ];

  for (const { path, host } of hostPaths) {
    if (existsSync(join(path, 'SKILL.md')) || existsSync(join(path, 'setup'))) {
      return { found: true, path, host };
    }
  }

  return { found: false, path: null, host: null };
}

/**
 * Install default identity templates (SOUL.md, USER.md, ACCESS_POLICY.md, HEARTBEAT.md)
 * into the agent workspace. Uses minimal defaults, not the soul-audit interview.
 */
export function installDefaultTemplates(workspaceDir: string): string[] {
  const gbrainRoot = dirname(dirname(__dirname)); // up from src/commands/ to repo root
  const templatesDir = join(gbrainRoot, 'templates');
  const installed: string[] = [];

  const templates = [
    { src: 'SOUL.md.template', dest: 'SOUL.md' },
    { src: 'USER.md.template', dest: 'USER.md' },
    { src: 'ACCESS_POLICY.md.template', dest: 'ACCESS_POLICY.md' },
    { src: 'HEARTBEAT.md.template', dest: 'HEARTBEAT.md' },
  ];

  for (const { src, dest } of templates) {
    const srcPath = join(templatesDir, src);
    const destPath = join(workspaceDir, dest);
    if (existsSync(srcPath) && !existsSync(destPath)) {
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
      installed.push(dest);
    }
  }

  return installed;
}

/**
 * Report post-init status including GStack detection and skill count.
 */
export function reportModStatus(): void {
  const gstack = detectGStack();
  const gbrainRoot = dirname(dirname(__dirname));
  const skillsDir = join(gbrainRoot, 'skills');

  let skillCount = 0;
  try {
    const manifest = JSON.parse(
      readFileSync(join(skillsDir, 'manifest.json'), 'utf-8')
    );
    skillCount = manifest.skills?.length || 0;
  } catch { /* manifest not found */ }

  console.log('');
  console.log('--- GBrain Mod Status ---');
  console.log(`Skills: ${skillCount} loaded`);
  console.log(`GStack: ${gstack.found ? `found (${gstack.host})` : 'not found'}`);
  if (!gstack.found) {
    console.log('  Install GStack for coding skills:');
    console.log('  git clone https://github.com/garrytan/gstack.git ~/.claude/skills/gstack');
    console.log('  cd ~/.claude/skills/gstack && ./setup');
  }
  console.log('Resolver: skills/RESOLVER.md');
  console.log('Soul audit: run `gbrain soul-audit` to customize agent identity');
  console.log('');
}

function printInitHelp() {
  console.log(`
gbrain init — initialize a brain (PGLite or Supabase Postgres)

USAGE
  gbrain init [flags]

ENGINE SELECTION (mutually exclusive)
  --pglite              Use embedded PGLite (zero-config, default for <1000 .md files)
  --supabase            Use Supabase Postgres (recommended for 1000+ files)
  --url <URL>           Use a manual Postgres connection string
  --mcp-only            Thin-client mode: connect to a remote gbrain MCP, no local engine

OPTIONS
  --force               Overwrite an existing config (gated by default)
  --non-interactive     Don't prompt; use defaults
  --migrate-only        Apply pending schema migrations against the configured engine
                        without re-saving config (used by post-upgrade and orchestrators)
  --json                JSON output for status reporting
  --path <DIR>          Override default brain path (PGLite only)
  --key <APIKEY>        Provide an API key non-interactively (Supabase only)
  --embedding-model <PROVIDER:MODEL>
                        e.g. openai:text-embedding-3-large, voyage:voyage-multimodal-3
  --model <PROVIDER>    Shorthand: pick recipe default for a provider
  --embedding-dimensions <N>
                        Embedding dimensions (must match the model)
  --expansion-model <PROVIDER:MODEL>
                        Model for query expansion (default: anthropic:claude-haiku)
  --chat-model <PROVIDER:MODEL>
                        Default subagent driver (v0.27+)

EXAMPLES
  gbrain init --pglite                      # Local-only, no API keys
  gbrain init --supabase                    # Interactive Supabase setup
  gbrain init --url postgresql://...        # Use a custom Postgres
  gbrain init --mcp-only --url https://...  # Thin-client mode

NOTES
  - Bare \`gbrain init\` in a directory with 1000+ .md files defaults to Supabase
    interactive setup. With <1000 files (or with --pglite explicitly), defaults
    to PGLite at ~/.gbrain/brain.pglite.
  - Existing config is preserved unless --force is passed.
`.trim());
}
