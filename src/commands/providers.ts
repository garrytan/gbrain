/**
 * `gbrain providers` CLI — list, test, env, explain.
 *
 * This command operates WITHOUT a brain connection (no engine needed) so
 * users can verify provider setup before `gbrain init`.
 */

import { listRecipes, getRecipe } from '../core/ai/recipes/index.ts';
import { configureGateway, embedOne, isAvailable as gwIsAvailable, chat as gwChat } from '../core/ai/gateway.ts';
import { probeOllama, probeLMStudio } from '../core/ai/probes.ts';
import { loadConfig } from '../core/config.ts';
import { AIConfigError, AITransientError } from '../core/ai/errors.ts';
import type { Recipe } from '../core/ai/types.ts';

const SCHEMA_VERSION = 1;

type TouchpointFilter = 'embedding' | 'expansion' | 'chat';

interface ProviderOption {
  id: string;
  touchpoint: TouchpointFilter;
  model: string;
  dims?: number;
  cost_per_1m_tokens_usd?: number;
  cost_per_1m_input_usd?: number;
  cost_per_1m_output_usd?: number;
  price_last_verified?: string;
  env_ready: boolean;
  tier: 'native' | 'openai-compat';
  pros: string[];
  cons: string[];
}

function configureFromEnv(): void {
  const config = loadConfig();
  configureGateway({
    embedding_model: config?.embedding_model,
    embedding_dimensions: config?.embedding_dimensions,
    expansion_model: config?.expansion_model,
    chat_model: config?.chat_model,
    chat_fallback_chain: config?.chat_fallback_chain,
    base_urls: config?.provider_base_urls,
    env: { ...process.env },
  });
}

function envReady(recipe: Recipe): boolean {
  const required = recipe.auth_env?.required ?? [];
  if (required.length === 0) return true; // e.g. local Ollama
  return required.every(k => !!process.env[k]);
}

export async function runProviders(subcommand: string | undefined, args: string[]): Promise<void> {
  configureFromEnv();

  switch (subcommand) {
    case 'list':
      return runList(args);
    case 'test':
      return runTest(args);
    case 'env':
      return runEnv(args);
    case 'explain':
      return runExplain(args);
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

TOUCHPOINTS
  --touchpoint embedding (default)  Probes embed_one("...")
  --touchpoint chat                 Probes chat({messages: [{role:'user', content:'ping'}]})

EXAMPLES
  gbrain providers list
  gbrain providers test --model openai:text-embedding-3-large
  gbrain providers test --touchpoint chat --model anthropic:claude-haiku-4-5
  gbrain providers test --touchpoint chat --model deepseek:deepseek-chat
  gbrain providers env ollama
  gbrain providers explain --json
`);
}

function runList(_args: string[]): void {
  const recipes = listRecipes();
  const rows: string[] = [];
  rows.push('PROVIDER'.padEnd(14) + 'TIER'.padEnd(18) + 'EMBED'.padEnd(8) + 'EXPAND'.padEnd(8) + 'CHAT'.padEnd(8) + 'STATUS');
  rows.push('-'.repeat(78));
  for (const r of recipes) {
    const hasEmbed = !!r.touchpoints.embedding && (r.touchpoints.embedding.models.length > 0);
    const hasExpand = !!r.touchpoints.expansion;
    const hasChat = !!r.touchpoints.chat && r.touchpoints.chat.models.length > 0;
    const ready = envReady(r);
    const status = ready ? '✓ ready' : `✗ missing ${r.auth_env?.required?.[0] ?? 'setup'}`;
    rows.push(
      r.id.padEnd(14) +
      r.tier.padEnd(18) +
      (hasEmbed ? 'yes' : '—').padEnd(8) +
      (hasExpand ? 'yes' : '—').padEnd(8) +
      (hasChat ? 'yes' : '—').padEnd(8) +
      status,
    );
  }
  console.log(rows.join('\n'));
}

async function runTest(args: string[]): Promise<void> {
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
    const [providerId, ...modelParts] = modelArg.split(':');
    const modelId = modelParts.join(':');
    const recipe = getRecipe(providerId);
    if (tpArg === 'embedding') {
      const dims = recipe?.touchpoints.embedding?.default_dims ?? 1536;
      configureGateway({
        embedding_model: modelArg,
        embedding_dimensions: dims,
        env: { ...process.env },
      });
    } else {
      configureGateway({
        chat_model: modelArg,
        env: { ...process.env },
      });
    }
  }

  if (!gwIsAvailable(tpArg)) {
    console.error(`${tpArg[0]?.toUpperCase()}${tpArg.slice(1)} provider not configured or not ready. Run \`gbrain providers list\` to see status.`);
    process.exit(1);
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

function runEnv(args: string[]): void {
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
  if (recipe.setup_hint) {
    console.log(`\n${recipe.setup_hint}`);
  }
}

async function runExplain(args: string[]): Promise<void> {
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

  const options: ProviderOption[] = [];
  for (const r of recipes) {
    if (r.touchpoints.embedding && r.touchpoints.embedding.models.length > 0) {
      const m = r.touchpoints.embedding;
      options.push({
        id: `${r.id}:${m.models[0]}`,
        touchpoint: 'embedding',
        model: m.models[0],
        dims: m.default_dims,
        cost_per_1m_tokens_usd: m.cost_per_1m_tokens_usd,
        price_last_verified: m.price_last_verified,
        env_ready: envReady(r) || (r.id === 'ollama' && ollama.models_endpoint_valid === true),
        tier: r.tier,
        pros: prosFor(r, 'embedding'),
        cons: consFor(r),
      });
    }
    if (r.touchpoints.expansion) {
      const m = r.touchpoints.expansion;
      options.push({
        id: `${r.id}:${m.models[0]}`,
        touchpoint: 'expansion',
        model: m.models[0],
        cost_per_1m_tokens_usd: m.cost_per_1m_tokens_usd,
        price_last_verified: m.price_last_verified,
        env_ready: envReady(r),
        tier: r.tier,
        pros: prosFor(r, 'expansion'),
        cons: consFor(r),
      });
    }
    if (r.touchpoints.chat && r.touchpoints.chat.models.length > 0) {
      const m = r.touchpoints.chat;
      options.push({
        id: `${r.id}:${m.models[0]}`,
        touchpoint: 'chat',
        model: m.models[0],
        cost_per_1m_input_usd: m.cost_per_1m_input_usd,
        cost_per_1m_output_usd: m.cost_per_1m_output_usd,
        price_last_verified: m.price_last_verified,
        env_ready: envReady(r),
        tier: r.tier,
        pros: prosFor(r, 'chat'),
        cons: consFor(r),
      });
    }
  }

  const recommended = pickRecommended(options, env_detected, ollama.models_endpoint_valid === true);

  const matrix = {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    env_detected,
    local_probes: {
      ollama: { url: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1', reachable: ollama.reachable, models_endpoint_valid: ollama.models_endpoint_valid === true },
      lmstudio: { url: process.env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234/v1', reachable: lmstudio.reachable, models_endpoint_valid: lmstudio.models_endpoint_valid === true },
    },
    options,
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
  for (const o of options.filter(x => x.touchpoint === 'embedding')) {
    const cost = o.cost_per_1m_tokens_usd !== undefined ? `$${o.cost_per_1m_tokens_usd}/1M` : '—';
    const dims = o.dims ? `${o.dims}d` : '—';
    console.log(`  ${o.env_ready ? '✓' : '✗'} ${o.id.padEnd(44)} ${dims.padEnd(8)} ${cost.padEnd(10)} ${o.tier}`);
  }
  console.log('');
  console.log('Expansion options:');
  for (const o of options.filter(x => x.touchpoint === 'expansion')) {
    const cost = o.cost_per_1m_tokens_usd !== undefined ? `$${o.cost_per_1m_tokens_usd}/1M` : '—';
    console.log(`  ${o.env_ready ? '✓' : '✗'} ${o.id.padEnd(44)} ${cost.padEnd(10)} ${o.tier}`);
  }
  console.log('');
  console.log('Chat options:');
  for (const o of options.filter(x => x.touchpoint === 'chat')) {
    const inCost = o.cost_per_1m_input_usd !== undefined ? `in $${o.cost_per_1m_input_usd}` : '—';
    const outCost = o.cost_per_1m_output_usd !== undefined ? `out $${o.cost_per_1m_output_usd}` : '—';
    console.log(`  ${o.env_ready ? '✓' : '✗'} ${o.id.padEnd(44)} ${inCost.padEnd(12)} ${outCost.padEnd(12)} ${o.tier}`);
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
