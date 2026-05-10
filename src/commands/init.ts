import { execSync } from 'child_process';
import { readdirSync, lstatSync, existsSync, copyFileSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { saveConfig, loadConfig, toEngineConfig, gbrainPath, configPath, isThinClient, type GBrainConfig } from '../core/config.ts';
import { createEngine } from '../core/engine-factory.ts';
import { discoverOAuth, mintClientCredentialsToken, smokeTestMcp } from '../core/remote-mcp-probe.ts';

export async function runInit(args: string[]) {
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

  // v0.14: AI provider selection.
  // --embedding-model PROVIDER:MODEL (verbose) or --model PROVIDER (shorthand, picks recipe default)
  const embModelIdx = args.indexOf('--embedding-model');
  const modelShortIdx = args.indexOf('--model');
  const embDimsIdx = args.indexOf('--embedding-dimensions');
  const expModelIdx = args.indexOf('--expansion-model');
  // v0.27: --chat-model PROVIDER:MODEL — default subagent driver.
  const chatModelIdx = args.indexOf('--chat-model');
  const aiOpts = await resolveAIOptions(
    embModelIdx !== -1 ? args[embModelIdx + 1] : null,
    modelShortIdx !== -1 ? args[modelShortIdx + 1] : null,
    embDimsIdx !== -1 ? parseInt(args[embDimsIdx + 1], 10) : null,
    expModelIdx !== -1 ? args[expModelIdx + 1] : null,
    chatModelIdx !== -1 ? args[chatModelIdx + 1] : null,
  );

  // Schema-only path: apply initSchema against the already-configured engine
  // without ever calling saveConfig. Used by apply-migrations, the stopgap
  // script, and the postinstall hook. Bare `gbrain init` defaults to PGLite
  // and overwrites any existing Postgres config — we must never take that
  // branch from a migration orchestrator.
  if (isMigrateOnly) {
    return initMigrateOnly({ jsonOutput });
  }

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

    return initPGLite({ jsonOutput, apiKey, customPath, aiOpts });
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

  return initPostgres({ databaseUrl, jsonOutput, apiKey, aiOpts });
}

/**
 * Resolve AI provider options from CLI flags. Verbose form (--embedding-model
 * openai:text-embedding-3-large) overrides shorthand (--model openai which
 * expands to the recipe's first embedding model).
 */
async function resolveAIOptions(
  verbose: string | null,
  shorthand: string | null,
  dimsArg: number | null,
  expansion: string | null,
  chat: string | null,
): Promise<{ embedding_model?: string; embedding_dimensions?: number; expansion_model?: string; chat_model?: string }> {
  const out: { embedding_model?: string; embedding_dimensions?: number; expansion_model?: string; chat_model?: string } = {};

  if (verbose) {
    out.embedding_model = verbose;
  } else if (shorthand) {
    const { getRecipe } = await import('../core/ai/recipes/index.ts');
    const recipe = getRecipe(shorthand);
    if (!recipe) {
      console.error(`Unknown provider: ${shorthand}. Run \`gbrain providers list\` to see known providers.`);
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
    if (recipe?.touchpoints.embedding?.default_dims) {
      out.embedding_dimensions = recipe.touchpoints.embedding.default_dims;
    }
  }

  if (expansion) out.expansion_model = expansion;
  if (chat) out.chat_model = chat;

  return out;
}

/**
 * Apply the schema against the already-configured engine. No saveConfig.
 * No PGLite fallback when no config exists. Used by migration orchestrators
 * to bump an existing brain's schema to the latest version without
 * clobbering the user's chosen engine.
 */
async function initMigrateOnly(opts: { jsonOutput: boolean }) {
  const config = loadConfig();
  if (!config) {
    const msg = 'No brain configured. Run `gbrain init` (interactive) or `gbrain init --pglite` / `gbrain init --supabase` first.';
    if (opts.jsonOutput) {
      console.log(JSON.stringify({ status: 'error', reason: 'no_config', message: msg }));
    } else {
      console.error(msg);
    }
    process.exit(1);
  }

  const engine = await createEngine(toEngineConfig(config));
  try {
    await engine.connect(toEngineConfig(config));
    await engine.initSchema();
  } finally {
    try { await engine.disconnect(); } catch { /* best-effort */ }
  }

  if (opts.jsonOutput) {
    console.log(JSON.stringify({ status: 'success', engine: config.engine, mode: 'migrate-only' }));
  } else {
    console.log(`Schema up to date (engine: ${config.engine}).`);
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

async function initPGLite(opts: {
  jsonOutput: boolean;
  apiKey: string | null;
  customPath: string | null;
  aiOpts?: { embedding_model?: string; embedding_dimensions?: number; expansion_model?: string; chat_model?: string };
}) {
  const dbPath = opts.customPath || gbrainPath('brain.pglite');
  console.log(`Setting up local brain with PGLite (no server needed)...`);

  // Configure AI gateway BEFORE initSchema so the vector column uses the right dim.
  if (opts.aiOpts?.embedding_model || opts.aiOpts?.chat_model) {
    const { configureGateway } = await import('../core/ai/gateway.ts');
    configureGateway({
      embedding_model: opts.aiOpts?.embedding_model,
      embedding_dimensions: opts.aiOpts?.embedding_dimensions,
      expansion_model: opts.aiOpts?.expansion_model,
      chat_model: opts.aiOpts?.chat_model,
      env: { ...process.env },
    });
    if (opts.aiOpts?.embedding_model) console.log(`  Embedding: ${opts.aiOpts.embedding_model} (${opts.aiOpts.embedding_dimensions ?? '?'}d)`);
    if (opts.aiOpts?.expansion_model) console.log(`  Expansion: ${opts.aiOpts.expansion_model}`);
    if (opts.aiOpts?.chat_model) console.log(`  Chat: ${opts.aiOpts.chat_model}`);
  }

  const engine = await createEngine({ engine: 'pglite' });
  try {
    await engine.connect({ database_path: dbPath, engine: 'pglite' });

    // v0.28.5 (A4): refuse to silently re-template an existing brain with a
    // mismatched embedding dimension. Loud failure beats the v0.27 silent-
    // corruption pattern that surfaced as #673.
    if (opts.aiOpts?.embedding_dimensions) {
      const { readContentChunksEmbeddingDim, embeddingMismatchMessage } = await import('../core/embedding-dim-check.ts');
      const existing = await readContentChunksEmbeddingDim(engine);
      if (existing.exists && existing.dims !== null && existing.dims !== opts.aiOpts.embedding_dimensions) {
        console.error('\n' + embeddingMismatchMessage({
          currentDims: existing.dims,
          requestedDims: opts.aiOpts.embedding_dimensions,
          requestedModel: opts.aiOpts.embedding_model,
          source: 'init',
        }) + '\n');
        if (opts.jsonOutput) {
          console.log(JSON.stringify({
            status: 'error',
            reason: 'embedding_dim_mismatch',
            current_dims: existing.dims,
            requested_dims: opts.aiOpts.embedding_dimensions,
          }));
        }
        process.exit(1);
      }
    }

    await engine.initSchema();

    const config: GBrainConfig = {
      engine: 'pglite',
      database_path: dbPath,
      ...(opts.apiKey ? { openai_api_key: opts.apiKey } : {}),
      ...(opts.aiOpts?.embedding_model ? { embedding_model: opts.aiOpts.embedding_model } : {}),
      ...(opts.aiOpts?.embedding_dimensions ? { embedding_dimensions: opts.aiOpts.embedding_dimensions } : {}),
      ...(opts.aiOpts?.expansion_model ? { expansion_model: opts.aiOpts.expansion_model } : {}),
      ...(opts.aiOpts?.chat_model ? { chat_model: opts.aiOpts.chat_model } : {}),
    };
    saveConfig(config);

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
    }
  } finally {
    try { await engine.disconnect(); } catch { /* best-effort */ }
  }
}

async function initPostgres(opts: {
  databaseUrl: string;
  jsonOutput: boolean;
  apiKey: string | null;
  aiOpts?: { embedding_model?: string; embedding_dimensions?: number; expansion_model?: string; chat_model?: string };
}) {
  const { databaseUrl } = opts;

  // Configure AI gateway BEFORE initSchema so the vector column uses the right dim.
  if (opts.aiOpts?.embedding_model || opts.aiOpts?.chat_model) {
    const { configureGateway } = await import('../core/ai/gateway.ts');
    configureGateway({
      embedding_model: opts.aiOpts?.embedding_model,
      embedding_dimensions: opts.aiOpts?.embedding_dimensions,
      expansion_model: opts.aiOpts?.expansion_model,
      chat_model: opts.aiOpts?.chat_model,
      env: { ...process.env },
    });
    if (opts.aiOpts?.embedding_model) console.log(`  Embedding: ${opts.aiOpts.embedding_model} (${opts.aiOpts.embedding_dimensions ?? '?'}d)`);
    if (opts.aiOpts?.expansion_model) console.log(`  Expansion: ${opts.aiOpts.expansion_model}`);
    if (opts.aiOpts?.chat_model) console.log(`  Chat: ${opts.aiOpts.chat_model}`);
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

    // v0.28.5 (A4): refuse to silently re-template an existing brain with a
    // mismatched embedding dimension (mirror of the PGLite path above).
    if (opts.aiOpts?.embedding_dimensions) {
      const { readContentChunksEmbeddingDim, embeddingMismatchMessage } = await import('../core/embedding-dim-check.ts');
      const existing = await readContentChunksEmbeddingDim(engine);
      if (existing.exists && existing.dims !== null && existing.dims !== opts.aiOpts.embedding_dimensions) {
        console.error('\n' + embeddingMismatchMessage({
          currentDims: existing.dims,
          requestedDims: opts.aiOpts.embedding_dimensions,
          requestedModel: opts.aiOpts.embedding_model,
          source: 'init',
        }) + '\n');
        if (opts.jsonOutput) {
          console.log(JSON.stringify({
            status: 'error',
            reason: 'embedding_dim_mismatch',
            current_dims: existing.dims,
            requested_dims: opts.aiOpts.embedding_dimensions,
          }));
        }
        process.exit(1);
      }
    }

    console.log('Running schema migration...');
    await engine.initSchema();

    const config: GBrainConfig = {
      engine: 'postgres',
      database_url: databaseUrl,
      ...(opts.apiKey ? { openai_api_key: opts.apiKey } : {}),
      ...(opts.aiOpts?.embedding_model ? { embedding_model: opts.aiOpts.embedding_model } : {}),
      ...(opts.aiOpts?.embedding_dimensions ? { embedding_dimensions: opts.aiOpts.embedding_dimensions } : {}),
      ...(opts.aiOpts?.expansion_model ? { expansion_model: opts.aiOpts.expansion_model } : {}),
      ...(opts.aiOpts?.chat_model ? { chat_model: opts.aiOpts.chat_model } : {}),
    };
    saveConfig(config);
    console.log('Config saved to ~/.gbrain/config.json');

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
