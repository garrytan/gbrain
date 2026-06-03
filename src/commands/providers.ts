/**
 * `gbrain providers` CLI — list, test, env, explain, verify.
 *
 * This command operates WITHOUT a brain connection (no engine needed) so
 * users can verify provider setup before `gbrain init`.
 */

import { listRecipes, getRecipe } from '../core/ai/recipes/index.ts';
import { configureGateway, embedOne, isAvailable as gwIsAvailable, chat as gwChat } from '../core/ai/gateway.ts';
import { probeOllama, probeLMStudio } from '../core/ai/probes.ts';
import { loadConfig } from '../core/config.ts';
import { AIConfigError, AITransientError } from '../core/ai/errors.ts';
import {
  codexAuthAvailable,
  codexAuthFailureDetail,
  codexAuthSetupHint,
  resolveCodexAuthSnapshot,
  type CodexAuthResolveOptions,
  type CodexCredentialSnapshot,
} from '../core/ai/codex-auth.ts';
import { classifyCapabilities } from '../core/ai/capabilities.ts';
import {
  buildCodexResponsesBody,
  buildCodexResponsesRequest,
  redactCodexSecrets,
} from '../core/ai/codex-responses.ts';
import type { BillingMetadata, Recipe } from '../core/ai/types.ts';
import { splitProviderModelId } from '../core/model-id.ts';

// v2: `tier` widened to include `codex-responses` for metadata-only Codex recipes.
const SCHEMA_VERSION = 2;

type TouchpointFilter = 'embedding' | 'expansion' | 'chat';

const OPENAI_CODEX_VERIFY_MODEL = 'openai-codex:gpt-5.5';
const VERIFY_FIXTURE_NOW_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const VERIFY_FIXTURE_EXPIRES_MS = Date.UTC(2030, 0, 1, 0, 0, 0);
const VERIFY_FIXTURE_PUBLIC_OPENAI_API_KEY = 'sk-openai-public-key-must-not-leak';
const VERIFY_FIXTURE_CODEX_ACCESS_TOKEN = fixtureJwt(VERIFY_FIXTURE_EXPIRES_MS / 1000);

interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

interface VerifyArgs {
  model: string;
  offline: boolean;
  live: boolean;
  help: boolean;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function fixtureJwt(expSeconds: number): string {
  return `${base64UrlJson({ alg: 'none', typ: 'JWT' })}.${base64UrlJson({ sub: 'codex_offline_readiness_fixture', exp: expSeconds })}.sig`;
}

interface ProviderOption {
  id: string;
  touchpoint: TouchpointFilter;
  model: string;
  dims?: number;
  cost_per_1m_tokens_usd?: number;
  cost_per_1m_input_usd?: number;
  cost_per_1m_output_usd?: number;
  billing?: BillingMetadata;
  billing_mode?: BillingMetadata['mode'];
  public_openai_api_key_used?: boolean;
  price_last_verified?: string;
  env_ready: boolean;
  base_url?: string;
  tier: Recipe['tier'];
  pros: string[];
  cons: string[];
}

export interface ProvidersCommandOptions {
  /** Fixture/path/read/clock seam for offline Codex auth tests. */
  codexAuth?: Omit<CodexAuthResolveOptions, 'env'>;
}

function providerBaseUrls(config?: { provider_base_urls?: Record<string, string> } | null): Record<string, string> | undefined {
  const envBaseUrls: Record<string, string> = {};
  if (process.env.OPENAI_CODEX_BASE_URL) envBaseUrls['openai-codex'] = process.env.OPENAI_CODEX_BASE_URL;
  const merged = { ...envBaseUrls, ...(config?.provider_base_urls ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function providerBaseUrl(recipe: Recipe, config?: { provider_base_urls?: Record<string, string> } | null): string | undefined {
  return providerBaseUrls(config)?.[recipe.id] ?? recipe.base_url_default;
}

function safeLoadProviderConfig(): { provider_base_urls?: Record<string, string> } | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

function normalizedHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return null;
  }
}

function isPublicOpenAIBaseURL(url: string | undefined): boolean {
  return normalizedHost(url) === 'api.openai.com';
}

function configureFromEnv(options: ProvidersCommandOptions = {}): void {
  const config = loadConfig();
  configureGateway({
    embedding_model: config?.embedding_model,
    embedding_dimensions: config?.embedding_dimensions,
    expansion_model: config?.expansion_model,
    chat_model: config?.chat_model,
    chat_fallback_chain: config?.chat_fallback_chain,
    base_urls: providerBaseUrls(config),
    env: { ...process.env },
    codex_auth_options: options.codexAuth,
  });
}

function isCodexRecipe(recipe: Recipe): boolean {
  return recipe.tier === 'codex-responses' || recipe.implementation === 'codex-responses';
}

function codexBillingSummary(recipe: Recipe): string | null {
  const billing = recipe.touchpoints.chat?.billing;
  if (!isCodexRecipe(recipe) || billing?.mode !== 'plan-billed') return null;
  return 'ChatGPT/Codex plan-billed; public OpenAI API key not used; quota/rate limits apply';
}

function codexSetupHint(): string {
  return 'Uses ChatGPT/Codex auth and the Codex Responses transport. OPENAI_API_KEY is ignored for this provider; ChatGPT/Codex plan quotas and rate limits still apply.';
}

function recipeForModelString(modelStr: string | undefined): Recipe | undefined {
  const providerId = splitProviderModelId(modelStr).provider;
  return providerId ? getRecipe(providerId) : undefined;
}

function chatBillingFields(recipe: Recipe, billing: BillingMetadata | undefined): Partial<ProviderOption> {
  if (!billing) return {};
  return {
    billing,
    billing_mode: billing.mode,
    ...(isCodexRecipe(recipe) ? { public_openai_api_key_used: false } : {}),
  };
}

function resolveCodexForProviders(
  env: Record<string, string | undefined>,
  options: ProvidersCommandOptions = {},
): CodexCredentialSnapshot {
  const codexAuth = options.codexAuth ?? { source: 'env' as const };
  return resolveCodexAuthSnapshot({ ...codexAuth, env });
}

export function envReady(
  recipe: Recipe,
  env: NodeJS.ProcessEnv = process.env,
  options: ProvidersCommandOptions = {},
): boolean {
  if (isCodexRecipe(recipe)) {
    return codexAuthAvailable(resolveCodexForProviders(env, options));
  }
  const required = recipe.auth_env?.required ?? [];
  if (required.length === 0) return true; // e.g. local Ollama
  return required.every(k => !!env[k]);
}

/**
 * Pure formatter for the recipe matrix shown by `gbrain providers list` and
 * the new `init-provider-picker` (D1+D2 — picker reuses this so its display
 * stays in sync with `providers list` and can't drift).
 *
 * Returns the multi-line string (joined with `\n`). Callers handle stdout vs.
 * stderr routing themselves.
 */
export function formatRecipeTable(
  recipes: Recipe[],
  env: NodeJS.ProcessEnv = process.env,
  options: ProvidersCommandOptions = {},
): string {
  const rows: string[] = [];
  // Dynamic column width: longest recipe id + 1 space, floor at 14 (the
  // historical default). v0.40.6.1 introduced `llama-server-reranker` (21 chars)
  // which overflowed the static 14-char column and made the row start with the
  // tier name (no space delimiter), breaking `each recipe appears at most once`
  // in test/providers.test.ts. Auto-widening keeps the contract — every row's
  // id is followed by at least one space — without per-recipe column tuning.
  const idCol = Math.max(14, ...recipes.map(r => r.id.length + 1));
  const totalWidth = idCol + 18 + 8 + 8 + 8 + 16; // tier+embed+expand+chat+status
  rows.push('PROVIDER'.padEnd(idCol) + 'TIER'.padEnd(18) + 'EMBED'.padEnd(8) + 'EXPAND'.padEnd(8) + 'CHAT'.padEnd(8) + 'STATUS');
  rows.push('-'.repeat(totalWidth));
  for (const r of recipes) {
    const hasEmbed = !!r.touchpoints.embedding && (r.touchpoints.embedding.models.length > 0);
    const hasExpand = !!r.touchpoints.expansion;
    const hasChat = !!r.touchpoints.chat && r.touchpoints.chat.models.length > 0;
    const codexSnapshot = isCodexRecipe(r) ? resolveCodexForProviders(env, options) : undefined;
    const ready = envReady(r, env, options);
    const baseStatus = ready
      ? '✓ ready'
      : codexSnapshot
        ? `✗ ${codexAuthFailureDetail(codexSnapshot)}`
        : `✗ missing ${r.auth_env?.required?.[0] ?? 'setup'}`;
    const billingSummary = codexBillingSummary(r);
    const status = billingSummary ? `${baseStatus} · ${billingSummary}` : baseStatus;
    rows.push(
      r.id.padEnd(idCol) +
      r.tier.padEnd(18) +
      (hasEmbed ? 'yes' : '—').padEnd(8) +
      (hasExpand ? 'yes' : '—').padEnd(8) +
      (hasChat ? 'yes' : '—').padEnd(8) +
      status,
    );
  }
  return rows.join('\n');
}

export async function runProviders(
  subcommand: string | undefined,
  args: string[],
  options: ProvidersCommandOptions = {},
): Promise<void> {
  // `providers verify --offline` is a deterministic readiness gate and must not
  // touch private Codex auth files or network. Handle it before configureGateway(),
  // because configureGateway resolves Codex auth snapshots eagerly.
  if (subcommand === 'verify') {
    return runVerify(args, options);
  }

  const runtimeOptions: ProvidersCommandOptions = options.codexAuth ? options : { ...options, codexAuth: {} };
  configureFromEnv(runtimeOptions);

  switch (subcommand) {
    case 'list':
      return runList(args, runtimeOptions);
    case 'test':
      return runTest(args, runtimeOptions);
    case 'env':
      return runEnv(args, runtimeOptions);
    case 'explain':
      return runExplain(args, runtimeOptions);
    case undefined:
    case '--help':
    case '-h':
      printHelp();
      return;
    default:
      console.error(`Unknown providers subcommand: ${subcommand}`);
      printHelp();
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`gbrain providers — AI provider status and testing

USAGE
  gbrain providers list                                   List all known providers + status
  gbrain providers test [--touchpoint T] [--model ID]     Smoke-test configured (or specified) providers
  gbrain providers env <id>                               Show env vars required/optional for a provider
  gbrain providers explain [--json]                       Emit a provider choice matrix (agent-friendly)
  gbrain providers verify --model ID --offline            Offline readiness gate for provider rollout

VERIFY
  --model openai-codex:gpt-5.5   Model to verify (default: openai-codex:gpt-5.5)
  --offline                      Deterministic; uses fixture auth only, no private auth files/network
  --live                         Optional live smoke; requires GBRAIN_OPENAI_CODEX_LIVE=1

TOUCHPOINTS
  --touchpoint embedding (default)  Probes embed_one("...")
  --touchpoint chat                 Probes chat({messages: [{role:'user', content:'ping'}]})

EXAMPLES
  gbrain providers list
  gbrain providers test --model openai:text-embedding-3-large
  gbrain providers test --touchpoint chat --model anthropic:claude-haiku-4-5
  gbrain providers test --touchpoint chat --model deepseek:deepseek-chat
  gbrain providers verify --model openai-codex:gpt-5.5 --offline
  GBRAIN_OPENAI_CODEX_LIVE=1 gbrain providers verify --model openai-codex:gpt-5.5 --live
  gbrain providers env ollama
  gbrain providers explain --json
`);
}

function runList(_args: string[], options: ProvidersCommandOptions = {}): void {
  console.log(formatRecipeTable(listRecipes(), process.env, options));
}

function parseVerifyArgs(args: string[]): VerifyArgs | { error: string } {
  let model: string | undefined;
  let offline = false;
  let live = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--offline') {
      offline = true;
      continue;
    }
    if (arg === '--live') {
      live = true;
      continue;
    }
    if (arg === '--model') {
      const next = args[i + 1];
      if (!next || next.startsWith('--')) return { error: '--model requires a provider:model value.' };
      model = next;
      i++;
      continue;
    }
    return { error: `Unknown providers verify option: ${arg}` };
  }

  if (offline && live) return { error: '--offline and --live are mutually exclusive.' };
  return {
    model: model ?? OPENAI_CODEX_VERIFY_MODEL,
    offline: offline || !live,
    live,
    help,
  };
}

function printVerifyHelp(): void {
  console.log(`gbrain providers verify — provider rollout readiness gate

USAGE
  gbrain providers verify --model openai-codex:gpt-5.5 --offline
  GBRAIN_OPENAI_CODEX_LIVE=1 gbrain providers verify --model openai-codex:gpt-5.5 --live

OPTIONS
  --model ID    Provider model id to verify (default: ${OPENAI_CODEX_VERIFY_MODEL})
  --offline     Deterministic fixture-auth checks only; no private auth files/network
  --live        Run offline checks, then a real chat smoke via providers test

Live mode is refused unless GBRAIN_OPENAI_CODEX_LIVE=1 is set.
`);
}

function verifyCheck(name: string, ok: boolean, passDetail: string, failDetail: string): VerifyCheck {
  return { name, ok, detail: ok ? passDetail : failDetail };
}

function verifyFixtureOptions(): ProvidersCommandOptions {
  return {
    codexAuth: {
      source: 'env',
      now: VERIFY_FIXTURE_NOW_MS,
      homeDir: '/gbrain-openai-codex-offline-readiness-fixture',
      readFileText: () => {
        throw new Error('offline verify must not read private auth files');
      },
    },
  };
}

function runOpenAICodexOfflineReadiness(modelArg: string): VerifyCheck[] {
  const checks: VerifyCheck[] = [];
  const parsed = splitProviderModelId(modelArg);
  const recipe = parsed.provider ? getRecipe(parsed.provider) : undefined;
  const chat = recipe?.touchpoints.chat;
  const expectedIdentity = !!recipe
    && recipe.id === 'openai-codex'
    && parsed.provider === 'openai-codex'
    && parsed.model === 'gpt-5.5'
    && recipe.tier === 'codex-responses'
    && recipe.implementation === 'codex-responses'
    && recipe.enforce_model_allowlist === true
    && chat?.models.includes(parsed.model) === true;

  checks.push(verifyCheck(
    'recipe/model identity',
    expectedIdentity,
    'openai-codex:gpt-5.5 is registered as the Codex Responses recipe with an enforced allow-list.',
    'expected openai-codex:gpt-5.5 to resolve to the Codex Responses recipe and allow-list.',
  ));

  const fixtureOptions = verifyFixtureOptions();
  const fixtureEnv: Record<string, string | undefined> = {
    OPENAI_API_KEY: VERIFY_FIXTURE_PUBLIC_OPENAI_API_KEY,
    OPENAI_CODEX_ACCESS_TOKEN: VERIFY_FIXTURE_CODEX_ACCESS_TOKEN,
  };
  const publicOnlyEnv: Record<string, string | undefined> = {
    OPENAI_API_KEY: VERIFY_FIXTURE_PUBLIC_OPENAI_API_KEY,
    OPENAI_CODEX_ACCESS_TOKEN: undefined,
  };
  const snapshot = resolveCodexForProviders(fixtureEnv, fixtureOptions);
  const verifyBaseURL = recipe ? providerBaseUrl(recipe, safeLoadProviderConfig()) : undefined;
  const serializedSnapshot = JSON.stringify(snapshot);
  const formattedTable = recipe ? formatRecipeTable([recipe], fixtureEnv, fixtureOptions) : '';
  const redactedSample = redactCodexSecrets(
    `Bearer ${VERIFY_FIXTURE_CODEX_ACCESS_TOKEN} access_token=${VERIFY_FIXTURE_CODEX_ACCESS_TOKEN} api_key=${VERIFY_FIXTURE_PUBLIC_OPENAI_API_KEY}`,
    [VERIFY_FIXTURE_CODEX_ACCESS_TOKEN, VERIFY_FIXTURE_PUBLIC_OPENAI_API_KEY],
  );
  const redactionProbe = [
    serializedSnapshot,
    codexAuthFailureDetail(snapshot),
    formattedTable,
    redactedSample,
  ].join('\n');
  const redactionOk = codexAuthAvailable(snapshot)
    && !Object.keys(snapshot as Record<string, unknown>).includes('accessToken')
    && !redactionProbe.includes(VERIFY_FIXTURE_CODEX_ACCESS_TOKEN)
    && !redactionProbe.includes(VERIFY_FIXTURE_PUBLIC_OPENAI_API_KEY)
    && redactedSample.includes('[REDACTED]');

  checks.push(verifyCheck(
    'auth redaction',
    redactionOk,
    'fixture Codex token/API key stay out of JSON and operator-facing status strings.',
    'fixture token/API key leaked or Codex fixture auth did not resolve as expected.',
  ));

  let streamRouteOk = false;
  let requestUsesCodexAuthOnly = false;
  try {
    const opts = {
      messages: [{ role: 'user' as const, content: 'Reply with just: pong' }],
      maxTokens: 4,
    };
    const body = buildCodexResponsesBody(opts, parsed.model);
    if (snapshot.ok && verifyBaseURL) {
      const request = buildCodexResponsesRequest({
        baseURL: verifyBaseURL,
        modelId: parsed.model,
        opts,
        credential: snapshot,
      });
      const url = new URL(request.url);
      const hostname = normalizedHost(request.url);
      const routeHostOk = hostname === 'chatgpt.com';
      const publicOpenAIHostOk = !isPublicOpenAIBaseURL(verifyBaseURL) && !isPublicOpenAIBaseURL(request.url);
      streamRouteOk = body.stream === true
        && body.store === false
        && request.body.stream === true
        && request.body.store === false
        && routeHostOk
        && url.pathname.endsWith('/backend-api/codex/responses')
        && publicOpenAIHostOk;
      requestUsesCodexAuthOnly = request.headers.Authorization === `Bearer ${VERIFY_FIXTURE_CODEX_ACCESS_TOKEN}`
        && !Object.values(request.headers).some(value => value.includes(VERIFY_FIXTURE_PUBLIC_OPENAI_API_KEY));
    }
  } catch {
    streamRouteOk = false;
  }

  checks.push(verifyCheck(
    'streaming route separation',
    streamRouteOk,
    'request builder forces stream=true/store=false and targets ChatGPT Codex /responses, not public OpenAI.',
    'Codex request builder did not prove forced streaming/store=false on the ChatGPT Codex route.',
  ));

  let toolsRejected = false;
  try {
    buildCodexResponsesBody({
      messages: [{ role: 'user', content: 'ping' }],
      tools: [{ name: 'noop', description: 'must be rejected', inputSchema: { type: 'object', properties: {} } }],
      maxTokens: 1,
    }, parsed.model);
  } catch (error) {
    toolsRejected = error instanceof AIConfigError && error.message.includes('text-only');
  }
  const capabilityVerdict = classifyCapabilities(modelArg);
  const noToolsOk = chat?.supports_tools === false
    && chat?.supports_subagent_loop === false
    && chat?.supports_prompt_cache === false
    && recipe?.touchpoints.embedding === undefined
    && recipe?.touchpoints.expansion === undefined
    && recipe?.touchpoints.reranker === undefined
    && capabilityVerdict === 'unusable:no_tools'
    && toolsRejected;

  checks.push(verifyCheck(
    'text-only/no-tools guard',
    noToolsOk,
    'recipe and transport reject tools/minion history; capability gate classifies Codex as unusable for subagent loops.',
    'Codex did not remain text-only/no-tools or the subagent capability gate changed.',
  ));

  const authKeys = [
    ...(recipe?.auth_env?.required ?? []),
    ...(recipe?.auth_env?.optional ?? []),
  ];
  const baseUrlAvoidsPublicOpenAI = !!verifyBaseURL && !isPublicOpenAIBaseURL(verifyBaseURL);
  const publicFallbackOk = !!recipe
    && recipe.id !== 'openai'
    && !authKeys.includes('OPENAI_API_KEY')
    && envReady(recipe, publicOnlyEnv, fixtureOptions) === false
    && requestUsesCodexAuthOnly
    && baseUrlAvoidsPublicOpenAI;

  checks.push(verifyCheck(
    'no public OpenAI fallback',
    publicFallbackOk,
    'OPENAI_API_KEY alone is not ready; Codex uses Codex auth and a non-api.openai.com route.',
    'public OPENAI_API_KEY was accepted or leaked into Codex auth/route invariants.',
  ));

  const billingSummary = recipe ? codexBillingSummary(recipe) : null;
  const planBillingOk = chat?.billing?.mode === 'plan-billed'
    && chat?.cost_per_1m_input_usd === undefined
    && chat?.cost_per_1m_output_usd === undefined
    && billingSummary !== null
    && billingSummary.includes('ChatGPT/Codex plan-billed')
    && billingSummary.includes('public OpenAI API key not used')
    && billingSummary.includes('quota/rate limits apply');

  checks.push(verifyCheck(
    'plan billing metadata',
    planBillingOk,
    'plan-billed metadata is present; public API metered prices remain unset and quota hints are surfaced.',
    'Codex plan-billing metadata or public-API-spend guardrails are missing.',
  ));

  return checks;
}

function printVerifyResult(model: string, mode: 'offline' | 'live', checks: VerifyCheck[]): void {
  console.log(`OpenAI Codex provider readiness (${mode})`);
  console.log(`Model: ${model}`);
  if (mode === 'offline') {
    console.log('Mode: offline fixture checks only; no private Codex auth files, live credentials, or network are used.');
  } else {
    console.log('Mode: live requested; offline gate runs first, then providers test runs only because GBRAIN_OPENAI_CODEX_LIVE=1.');
  }
  console.log('');
  for (const check of checks) {
    console.log(`${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`);
  }
  const failed = checks.filter(check => !check.ok);
  console.log('');
  if (failed.length === 0) {
    console.log(mode === 'offline'
      ? 'Result: READY (offline invariants passed).'
      : 'Result: READY for live smoke (offline invariants passed).');
    if (mode === 'offline') {
      console.log('Optional live smoke: GBRAIN_OPENAI_CODEX_LIVE=1 gbrain providers verify --model openai-codex:gpt-5.5 --live');
    }
  } else {
    console.log(`Result: NOT READY (${failed.length} check${failed.length === 1 ? '' : 's'} failed).`);
  }
}

async function runVerify(args: string[], options: ProvidersCommandOptions = {}): Promise<void> {
  const parsed = parseVerifyArgs(args);
  if ('error' in parsed) {
    console.error(parsed.error);
    printVerifyHelp();
    process.exit(2);
  }
  if (parsed.help) {
    printVerifyHelp();
    return;
  }
  if (parsed.live && process.env.GBRAIN_OPENAI_CODEX_LIVE !== '1') {
    console.error('Live Codex verify is disabled. Set GBRAIN_OPENAI_CODEX_LIVE=1 to allow live auth/network.');
    process.exit(2);
  }

  const mode = parsed.offline ? 'offline' as const : 'live' as const;
  const checks = runOpenAICodexOfflineReadiness(parsed.model);
  printVerifyResult(parsed.model, mode, checks);
  if (checks.some(check => !check.ok)) process.exit(1);

  if (parsed.live) {
    console.log('');
    console.log('Live smoke: running providers test --touchpoint chat (secrets are not printed).');
    await runTest(['--touchpoint', 'chat', '--model', parsed.model], options);
  }
}

async function runTest(args: string[], options: ProvidersCommandOptions = {}): Promise<void> {
  const modelIdx = args.indexOf('--model');
  const modelArg = modelIdx >= 0 ? args[modelIdx + 1] : undefined;

  const tpIdx = args.indexOf('--touchpoint');
  const tpArg = (tpIdx >= 0 ? args[tpIdx + 1] : 'embedding') as TouchpointFilter;

  if (tpArg !== 'embedding' && tpArg !== 'chat') {
    console.error(`--touchpoint must be 'embedding' or 'chat' (got: ${tpArg}).`);
    process.exit(1);
  }

  // If --model passed, override gateway for this test (touchpoint-aware).
  if (modelArg) {
    const { model: modelId } = splitProviderModelId(modelArg);
    const recipe = recipeForModelString(modelArg);

    // codex finding #10: when `--model` is passed, the user is probing a
    // model in isolation. They may be misled into thinking the test result
    // validates their brain's actual configured path. Loud stderr line names
    // the divergence at the top of the test so the recovery experience
    // doesn't repeat the bug-reporter's "providers test ✓ but import still
    // broken" trap.
    try {
      const cfg = loadConfig();
      const configuredModel = tpArg === 'embedding' ? cfg?.embedding_model : cfg?.chat_model;
      if (!configuredModel) {
        console.error(
          `Note: tested ${modelArg} in isolation; this brain has no configured ${tpArg}_model yet. ` +
          `\`providers test\` does NOT verify your brain's active path. ` +
          `Set the active provider with \`gbrain config set ${tpArg}_model <id>\` after running init.`,
        );
      } else if (configuredModel !== modelArg) {
        console.error(
          `Note: tested ${modelArg} in isolation; gbrain's configured ${tpArg} is ${configuredModel}. ` +
          `\`providers test\` does NOT verify your brain's active path.`,
        );
      }
    } catch { /* loadConfig throws when no brain configured — first-time install path; the no-config branch above handles it. */ }

    if (tpArg === 'embedding') {
      const dims = recipe?.touchpoints.embedding?.default_dims ?? 1536;
      configureGateway({
        embedding_model: modelArg,
        embedding_dimensions: dims,
        base_urls: providerBaseUrls(loadConfig()),
        env: { ...process.env },
        codex_auth_options: options.codexAuth,
      });
    } else {
      configureGateway({
        chat_model: modelArg,
        base_urls: providerBaseUrls(loadConfig()),
        env: { ...process.env },
        codex_auth_options: options.codexAuth,
      });
    }
    void modelId; // intentionally unused but preserved for readability
  }

  const probedModel = modelArg ?? (() => {
    try {
      const cfg = loadConfig();
      return tpArg === 'embedding' ? cfg?.embedding_model : cfg?.chat_model;
    } catch {
      return undefined;
    }
  })();
  const probedRecipe = recipeForModelString(probedModel);

  if (!gwIsAvailable(tpArg)) {
    const label = `${tpArg[0]?.toUpperCase()}${tpArg.slice(1)}`;
    if (probedRecipe && isCodexRecipe(probedRecipe)) {
      const snapshot = resolveCodexForProviders(process.env, options);
      console.error(`${label} provider unavailable: ${codexAuthFailureDetail(snapshot)}`);
      const billingSummary = codexBillingSummary(probedRecipe);
      if (billingSummary) console.error(`Billing: ${billingSummary}`);
    } else {
      console.error(`${label} provider not configured or not ready. Run \`gbrain providers list\` to see status.`);
    }
    process.exit(1);
  }

  if (probedRecipe && isCodexRecipe(probedRecipe)) {
    const billingSummary = codexBillingSummary(probedRecipe);
    if (billingSummary) console.log(`Billing: ${billingSummary}`);
  }

  console.log(`Probing ${tpArg} provider...`);
  const start = Date.now();
  try {
    if (tpArg === 'embedding') {
      const v = await embedOne('gbrain smoke test');
      const ms = Date.now() - start;
      console.log(`  ✓ ${ms}ms, ${v.length} dims`);
    } else {
      const result = await gwChat({
        messages: [{ role: 'user', content: 'Reply with just the word: pong' }],
        maxTokens: 16,
      });
      const ms = Date.now() - start;
      const preview = (result.text || '<empty>').replace(/\s+/g, ' ').slice(0, 80);
      console.log(`  ✓ ${ms}ms · model=${result.model} · stop=${result.stopReason} · in=${result.usage.input_tokens}/out=${result.usage.output_tokens} · "${preview}"`);
    }
    console.log('\nAll probes green.');
  } catch (e) {
    const ms = Date.now() - start;
    if (e instanceof AIConfigError) {
      console.error(`  ✗ config error (${ms}ms): ${e.message}`);
      if (e.fix) console.error(`    Fix: ${e.fix}`);
      process.exit(2);
    } else if (e instanceof AITransientError) {
      console.error(`  ✗ transient error (${ms}ms): ${e.message}`);
      console.error(`    Retry after a moment.`);
      process.exit(3);
    } else {
      console.error(`  ✗ unknown error (${ms}ms): ${e instanceof Error ? e.message : e}`);
      process.exit(4);
    }
  }
}

function runEnv(args: string[], options: ProvidersCommandOptions = {}): void {
  const id = args[0];
  if (!id) {
    console.error('Usage: gbrain providers env <id>');
    process.exit(1);
  }
  const recipe = getRecipe(id);
  if (!recipe) {
    console.error(`Unknown provider: ${id}. Run \`gbrain providers list\` to see known providers.`);
    process.exit(1);
  }
  console.log(`${recipe.name} (${recipe.id})`);
  console.log('');
  const required = recipe.auth_env?.required ?? [];
  const optional = recipe.auth_env?.optional ?? [];
  if (required.length > 0) {
    console.log('Required:');
    for (const k of required) {
      const set = !!process.env[k];
      console.log(`  ${k.padEnd(32)} ${set ? '✓ set' : '✗ not set'}`);
    }
  } else {
    console.log('Required: (none)');
  }
  if (optional.length > 0) {
    console.log('\nOptional:');
    for (const k of optional) {
      const set = !!process.env[k];
      console.log(`  ${k.padEnd(32)} ${set ? '✓ set' : '✗ not set'}`);
    }
  }
  if (recipe.auth_env?.setup_url) {
    console.log(`\nSetup: ${recipe.auth_env.setup_url}`);
  }
  if (isCodexRecipe(recipe)) {
    const snapshot = resolveCodexForProviders(process.env, options);
    const billingSummary = codexBillingSummary(recipe);
    console.log(`\nCodex auth: ${codexAuthFailureDetail(snapshot)}`);
    if (billingSummary) console.log(`Billing: ${billingSummary}`);
    const quotaHint = recipe.touchpoints.chat?.billing?.quota_hint;
    if (quotaHint) console.log(`Limits: ${quotaHint}`);
    console.log('Public OpenAI API key: not used for openai-codex');
    console.log('Readiness: Codex auth only; OPENAI_API_KEY does not make openai-codex ready.');
    const baseURL = providerBaseUrl(recipe, loadConfig());
    if (baseURL) console.log(`Base URL: ${baseURL}`);
  }
  if (isCodexRecipe(recipe)) {
    console.log(`\n${codexSetupHint()}`);
  } else if (recipe.setup_hint) {
    console.log(`\n${recipe.setup_hint}`);
  }
}

async function runExplain(args: string[], cmdOptions: ProvidersCommandOptions = {}): Promise<void> {
  const asJson = args.includes('--json') || args.includes('-j');

  const recipes = listRecipes();
  const env_detected = {
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    GOOGLE_GENERATIVE_AI_API_KEY: !!process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    VOYAGE_API_KEY: !!process.env.VOYAGE_API_KEY,
    DEEPSEEK_API_KEY: !!process.env.DEEPSEEK_API_KEY,
    GROQ_API_KEY: !!process.env.GROQ_API_KEY,
    TOGETHER_API_KEY: !!process.env.TOGETHER_API_KEY,
  };

  // Parallel probes for local providers (1s timeout each)
  const [ollama, lmstudio] = await Promise.all([probeOllama(), probeLMStudio()]);
  const config = loadConfig();
  const baseUrls = providerBaseUrls(config);

  const providerOptions: ProviderOption[] = [];
  for (const r of recipes) {
    const baseURL = baseUrls?.[r.id] ?? r.base_url_default;
    if (r.touchpoints.embedding && r.touchpoints.embedding.models.length > 0) {
      const m = r.touchpoints.embedding;
      providerOptions.push({
        id: `${r.id}:${m.models[0]}`,
        touchpoint: 'embedding',
        model: m.models[0],
        dims: m.default_dims,
        cost_per_1m_tokens_usd: m.cost_per_1m_tokens_usd,
        price_last_verified: m.price_last_verified,
        env_ready: envReady(r, process.env, cmdOptions) || (r.id === 'ollama' && ollama.models_endpoint_valid === true),
        ...(baseURL ? { base_url: baseURL } : {}),
        tier: r.tier,
        pros: prosFor(r, 'embedding'),
        cons: consFor(r),
      });
    }
    if (r.touchpoints.expansion) {
      const m = r.touchpoints.expansion;
      providerOptions.push({
        id: `${r.id}:${m.models[0]}`,
        touchpoint: 'expansion',
        model: m.models[0],
        cost_per_1m_tokens_usd: m.cost_per_1m_tokens_usd,
        price_last_verified: m.price_last_verified,
        env_ready: envReady(r, process.env, cmdOptions),
        ...(baseURL ? { base_url: baseURL } : {}),
        tier: r.tier,
        pros: prosFor(r, 'expansion'),
        cons: consFor(r),
      });
    }
    if (r.touchpoints.chat && r.touchpoints.chat.models.length > 0) {
      const m = r.touchpoints.chat;
      providerOptions.push({
        id: `${r.id}:${m.models[0]}`,
        touchpoint: 'chat',
        model: m.models[0],
        cost_per_1m_input_usd: m.cost_per_1m_input_usd,
        cost_per_1m_output_usd: m.cost_per_1m_output_usd,
        ...chatBillingFields(r, m.billing),
        price_last_verified: m.price_last_verified,
        env_ready: envReady(r, process.env, cmdOptions),
        ...(baseURL ? { base_url: baseURL } : {}),
        tier: r.tier,
        pros: prosFor(r, 'chat'),
        cons: consFor(r),
      });
    }
  }

  const recommended = pickRecommended(providerOptions, env_detected, ollama.models_endpoint_valid === true);

  const matrix = {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    env_detected,
    local_probes: {
      ollama: { url: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1', reachable: ollama.reachable, models_endpoint_valid: ollama.models_endpoint_valid === true },
      lmstudio: { url: process.env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234/v1', reachable: lmstudio.reachable, models_endpoint_valid: lmstudio.models_endpoint_valid === true },
    },
    options: providerOptions,
    recommended: recommended.id,
    recommended_reason: recommended.reason,
  };

  if (asJson) {
    console.log(JSON.stringify(matrix, null, 2));
    return;
  }

  // Human-readable table
  console.log(`Provider matrix (schema v${SCHEMA_VERSION}, generated ${matrix.generated_at})`);
  console.log('');
  console.log('Environment:');
  for (const [k, v] of Object.entries(env_detected)) console.log(`  ${k.padEnd(32)} ${v ? '✓ set' : '✗ not set'}`);
  console.log(`  Ollama @ ${matrix.local_probes.ollama.url}  ${matrix.local_probes.ollama.models_endpoint_valid ? '✓ reachable' : '✗ not detected'}`);
  console.log('');
  console.log('Embedding options:');
  for (const o of providerOptions.filter(x => x.touchpoint === 'embedding')) {
    const cost = o.cost_per_1m_tokens_usd !== undefined ? `$${o.cost_per_1m_tokens_usd}/1M` : '—';
    const dims = o.dims ? `${o.dims}d` : '—';
    console.log(`  ${o.env_ready ? '✓' : '✗'} ${o.id.padEnd(44)} ${dims.padEnd(8)} ${cost.padEnd(10)} ${o.tier}`);
  }
  console.log('');
  console.log('Expansion options:');
  for (const o of providerOptions.filter(x => x.touchpoint === 'expansion')) {
    const cost = o.cost_per_1m_tokens_usd !== undefined ? `$${o.cost_per_1m_tokens_usd}/1M` : '—';
    console.log(`  ${o.env_ready ? '✓' : '✗'} ${o.id.padEnd(44)} ${cost.padEnd(10)} ${o.tier}`);
  }
  console.log('');
  console.log('Chat options:');
  for (const o of providerOptions.filter(x => x.touchpoint === 'chat')) {
    const price = o.billing_mode === 'plan-billed'
      ? 'plan-billed; public OpenAI API key not used; quota/rate limits apply'
      : `${(o.cost_per_1m_input_usd !== undefined ? `in $${o.cost_per_1m_input_usd}` : '—').padEnd(12)} ${(o.cost_per_1m_output_usd !== undefined ? `out $${o.cost_per_1m_output_usd}` : '—').padEnd(12)}`;
    console.log(`  ${o.env_ready ? '✓' : '✗'} ${o.id.padEnd(44)} ${price.padEnd(72)} ${o.tier}`);
  }
  console.log('');
  console.log(`Recommended: ${matrix.recommended}`);
  console.log(`  ${matrix.recommended_reason}`);
  console.log('');
  console.log('Re-invoke:');
  console.log(`  gbrain init --embedding-model ${matrix.recommended.split(':')[0]}:${matrix.recommended.split(':').slice(1).join(':')}`);
}

function prosFor(r: Recipe, touchpoint: TouchpointFilter): string[] {
  const out: string[] = [];
  if (touchpoint === 'chat') {
    if (r.id === 'anthropic') out.push('Default subagent driver', 'Prompt-cache support', 'Strong tool calling');
    else if (r.id === 'openai') out.push('Strong tool calling', 'Wide adapter support');
    else if (r.id === 'google') out.push('1M context', 'Cheap');
    else if (r.id === 'deepseek') out.push('25-40x cheaper than Anthropic', 'Strong reasoning');
    else if (r.id === 'groq') out.push('500 tok/s inference', 'Cheap fallback');
    else if (r.id === 'together') out.push('Open-weights house', 'Llama / Qwen / Mixtral');
    else if (r.id === 'openai-codex') out.push('ChatGPT/Codex plan-billed', 'No public OpenAI API spend');
    return out;
  }
  if (r.id === 'openai') out.push('Default', 'High quality', 'Wide compatibility');
  else if (r.id === 'google') out.push('Smaller vectors', 'Matryoshka dim flex');
  else if (r.id === 'anthropic') out.push('Default expansion model', 'Best-in-class reasoning');
  else if (r.id === 'ollama') out.push('Local', 'Free', 'Private');
  else if (r.id === 'voyage') out.push('Best rerank pairing');
  else if (r.id === 'litellm') out.push('Universal coverage (Bedrock/Vertex/Azure/any)');
  return out;
}

function consFor(r: Recipe): string[] {
  const out: string[] = [];
  if (r.tier === 'native' && r.id !== 'ollama') out.push('Paid');
  if (r.id === 'openai-codex') out.push('Requires Codex auth; plan quota/rate limits apply');
  if (r.id === 'ollama') out.push('Requires Ollama daemon running');
  if (r.id === 'litellm') out.push('Requires LiteLLM proxy + config');
  return out;
}

function pickRecommended(options: ProviderOption[], env: Record<string, boolean>, ollamaReady: boolean): { id: string; reason: string } {
  // Embedding recommendation: prefer env-ready native providers in this order.
  const embOpts = options.filter(o => o.touchpoint === 'embedding');
  if (env.OPENAI_API_KEY) {
    const openai = embOpts.find(o => o.id.startsWith('openai:'));
    if (openai) return { id: openai.id, reason: 'OPENAI_API_KEY set — OpenAI default is high-quality and preserves existing 1536-dim schema.' };
  }
  if (ollamaReady) {
    const ollama = embOpts.find(o => o.id.startsWith('ollama:'));
    if (ollama) return { id: ollama.id, reason: 'Ollama detected locally — zero cost + private.' };
  }
  if (env.GOOGLE_GENERATIVE_AI_API_KEY) {
    const google = embOpts.find(o => o.id.startsWith('google:'));
    if (google) return { id: google.id, reason: 'GOOGLE_GENERATIVE_AI_API_KEY set — Gemini embedding at 768 dims.' };
  }
  if (env.VOYAGE_API_KEY) {
    const voyage = embOpts.find(o => o.id.startsWith('voyage:'));
    if (voyage) return { id: voyage.id, reason: 'VOYAGE_API_KEY set — Voyage at 1024 dims.' };
  }
  // Nothing ready. Recommend OpenAI as the lowest-friction path.
  return {
    id: 'openai:text-embedding-3-large',
    reason: 'No provider env detected. OpenAI is the fastest setup — get a key at https://platform.openai.com/api-keys.',
  };
}
