/**
 * v0.28: tests for the unified model resolver. Pure-function-style tests using
 * a tiny stub engine — no DB, no PGLite, no Postgres needed.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  resolveModel,
  resolveModelDetailed,
  resolveAlias,
  resolveTierDefault,
  resolveEffectiveChatModel,
  providerKeyReady,
  openaiStaticTierFallback,
  DEFAULT_ALIASES,
  TIER_DEFAULTS,
  PROVIDER_TIER_DEFAULTS,
  isAnthropicProvider,
  isOpenRouterAnthropic,
  _resetDeprecationWarningsForTest,
} from '../src/core/model-config.ts';
import type { GBrainConfig } from '../src/core/config.ts';

class StubEngine {
  readonly kind = 'pglite' as const;
  private cfg = new Map<string, string>();
  set(key: string, value: string) { this.cfg.set(key, value); }
  async getConfig(key: string) { return this.cfg.get(key) ?? null; }
  // unused stubs to satisfy the BrainEngine duck-type at the resolveModel boundary
  async setConfig() {}
}

let stub: StubEngine;
let stderrCapture: string;
const origWrite = process.stderr.write.bind(process.stderr);

// Hermetic-env pinning (TODOS:1200 class): the key-aware tier default reads
// provider keys from process.env AND ~/.gbrain/config.json. Without pinning,
// every default-path assertion below would flip on a dev shell that exports
// only OPENAI_API_KEY (or carries keys in config.json). Save/delete the key
// envs and point GBRAIN_HOME at a nonexistent dir so the config read misses —
// local runs then match keyless CI byte-for-byte.
const PINNED_ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GBRAIN_HOME'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  stub = new StubEngine();
  stderrCapture = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrCapture += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  delete process.env.GBRAIN_MODEL;
  savedEnv = {};
  for (const k of PINNED_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GBRAIN_HOME = '/nonexistent-gbrain-home-for-model-config-tests';
  _resetDeprecationWarningsForTest();
});

afterEach(() => {
  process.stderr.write = origWrite;
  for (const k of PINNED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('resolveAlias', () => {
  test('built-in aliases resolve to full ids', async () => {
    expect(await resolveAlias(null, 'opus')).toBe(DEFAULT_ALIASES.opus);
    expect(await resolveAlias(null, 'sonnet')).toBe(DEFAULT_ALIASES.sonnet);
    expect(await resolveAlias(null, 'haiku')).toBe(DEFAULT_ALIASES.haiku);
  });

  test('unknown alias passes through (treats as full id)', async () => {
    expect(await resolveAlias(null, 'claude-experimental-9000')).toBe('claude-experimental-9000');
  });

  test('user-defined alias overrides built-in', async () => {
    stub.set('models.aliases.opus', 'claude-opus-4-7-1m');
    expect(await resolveAlias(stub as never, 'opus')).toBe('claude-opus-4-7-1m');
  });

  test('cycle in aliases breaks at depth 2', async () => {
    stub.set('models.aliases.a', 'b');
    stub.set('models.aliases.b', 'a');
    const result = await resolveAlias(stub as never, 'a');
    expect(typeof result).toBe('string');
  });
});

describe('resolveModel — 6-tier precedence', () => {
  test('CLI flag wins over everything', async () => {
    stub.set('models.dream.synthesize', 'sonnet');
    stub.set('models.default', 'opus');
    process.env.GBRAIN_MODEL = 'haiku';
    const m = await resolveModel(stub as never, {
      cliFlag: 'gemini',
      configKey: 'models.dream.synthesize',
      fallback: 'sonnet',
    });
    expect(m).toBe(DEFAULT_ALIASES.gemini);
  });

  test('new-key config wins over deprecated key, deprecated key wins over default', async () => {
    stub.set('models.dream.synthesize', 'opus');
    stub.set('dream.synthesize.model', 'sonnet');
    stub.set('models.default', 'haiku');
    const m = await resolveModel(stub as never, {
      configKey: 'models.dream.synthesize',
      deprecatedConfigKey: 'dream.synthesize.model',
      fallback: 'sonnet',
    });
    expect(m).toBe(DEFAULT_ALIASES.opus);
    expect(stderrCapture).toContain('deprecated config "dream.synthesize.model" ignored');
  });

  test('deprecated key honored when new key absent (with warning)', async () => {
    stub.set('dream.synthesize.model', 'opus');
    const m = await resolveModel(stub as never, {
      configKey: 'models.dream.synthesize',
      deprecatedConfigKey: 'dream.synthesize.model',
      fallback: 'sonnet',
    });
    expect(m).toBe(DEFAULT_ALIASES.opus);
    expect(stderrCapture).toContain('deprecated config "dream.synthesize.model" honored');
  });

  test('global default used when per-key keys absent', async () => {
    stub.set('models.default', 'opus');
    const m = await resolveModel(stub as never, {
      configKey: 'models.dream.synthesize',
      fallback: 'sonnet',
    });
    expect(m).toBe(DEFAULT_ALIASES.opus);
  });

  test('env var used when no config set', async () => {
    process.env.GBRAIN_MODEL = 'haiku';
    const m = await resolveModel(stub as never, {
      configKey: 'models.dream.synthesize',
      fallback: 'sonnet',
    });
    expect(m).toBe(DEFAULT_ALIASES.haiku);
  });

  test('hardcoded fallback last', async () => {
    const m = await resolveModel(stub as never, {
      configKey: 'models.dream.synthesize',
      fallback: 'sonnet',
    });
    expect(m).toBe(DEFAULT_ALIASES.sonnet);
  });

  test('subagent tier: loop-incapable models.tier.subagent falls back to TIER_DEFAULTS with warn', async () => {
    // moonshot supports tools but declares supports_subagent_loop: false —
    // pre-fix enforceSubagentCapable classified it tools-sufficient and let
    // the inherited tier value drive the loop.
    stub.set('models.tier.subagent', 'moonshot:kimi-k2.5');
    const m = await resolveModel(stub as never, {
      tier: 'subagent',
      configKey: 'models.subagent',
      fallback: TIER_DEFAULTS.subagent,
    });
    expect(m).toBe(TIER_DEFAULTS.subagent);
    expect(stderrCapture).toContain('supports_subagent_loop: false');
  });

  test('deprecation warning fires once per process per key', async () => {
    stub.set('dream.synthesize.model', 'opus');
    await resolveModel(stub as never, {
      configKey: 'models.dream.synthesize',
      deprecatedConfigKey: 'dream.synthesize.model',
      fallback: 'sonnet',
    });
    const firstWarn = stderrCapture;
    stderrCapture = '';
    await resolveModel(stub as never, {
      configKey: 'models.dream.synthesize',
      deprecatedConfigKey: 'dream.synthesize.model',
      fallback: 'sonnet',
    });
    expect(firstWarn).toContain('deprecated config');
    expect(stderrCapture).toBe('');
  });
});

describe('resolveModel — v0.31.12 tier system', () => {
  test('models.tier.<tier> beats models.default (#3873 — specific over generic)', async () => {
    stub.set('models.default', 'opus');
    stub.set('models.tier.reasoning', 'haiku');
    const m = await resolveModel(stub as never, {
      tier: 'reasoning',
      fallback: 'sonnet',
    });
    expect(m).toBe(DEFAULT_ALIASES.haiku);
  });

  test('models.default still applies when the call has no tier (#3873)', async () => {
    stub.set('models.default', 'opus');
    stub.set('models.tier.reasoning', 'haiku');
    const m = await resolveModel(stub as never, {
      fallback: 'sonnet',
    });
    expect(m).toBe(DEFAULT_ALIASES.opus);
  });

  test('models.default still applies when the tier has no override (#3873)', async () => {
    stub.set('models.default', 'opus');
    const m = await resolveModel(stub as never, {
      tier: 'reasoning',
      fallback: 'sonnet',
    });
    expect(m).toBe(DEFAULT_ALIASES.opus);
  });

  test('models.tier.<tier> beats env + fallback', async () => {
    stub.set('models.tier.reasoning', 'opus');
    process.env.GBRAIN_MODEL = 'haiku';
    const m = await resolveModel(stub as never, {
      tier: 'reasoning',
      fallback: 'sonnet',
    });
    expect(m).toBe(DEFAULT_ALIASES.opus);
  });

  test('TIER_DEFAULTS wins over caller fallback when no override', async () => {
    const m = await resolveModel(stub as never, {
      tier: 'reasoning',
      fallback: 'haiku',
    });
    expect(m).toBe(TIER_DEFAULTS.reasoning);
  });

  test('v0.38 D7: tier.subagent accepts non-Anthropic models that support tools (with cost warn)', async () => {
    // Pre-v0.38 the resolver hard-fell-back to TIER_DEFAULTS.subagent for any
    // non-Anthropic model. v0.38 (D6/D7) replaces that with a capability check:
    // a provider with tools but no prompt caching → resolved unchanged + warn
    // about the cost regression on long loops (not a refusal).
    stub.set('models.default', 'google:gemini-1.5-pro');
    const m = await resolveModel(stub as never, {
      tier: 'subagent',
      fallback: 'sonnet',
    });
    expect(m).toBe('google:gemini-1.5-pro');
    expect(stderrCapture).toContain('caching');
  });

  test('v0.38 D7: a provider that caches automatically is accepted WITHOUT the cost warn', async () => {
    // The warn advises moving to an Anthropic model "for lower cost on long
    // loops". On providers that already cache prompt prefixes server-side that
    // advice is backwards, so the capability check must not fire it.
    stub.set('models.default', 'openai:gpt-5.2');
    const m = await resolveModel(stub as never, {
      tier: 'subagent',
      fallback: 'sonnet',
    });
    expect(m).toBe('openai:gpt-5.2');
    expect(stderrCapture).not.toContain('caching');
  });

  test('v0.38 D7: tier.subagent rejects unknown providers (falls back to default)', async () => {
    // Unknown providers fail the capability check (verdict='unknown'); the
    // resolver falls back to TIER_DEFAULTS.subagent rather than burn money on
    // an unverified model.
    stub.set('models.tier.subagent', 'madeup-provider:weird-model');
    const m = await resolveModel(stub as never, {
      tier: 'subagent',
      fallback: 'sonnet',
    });
    expect(m).toBe(TIER_DEFAULTS.subagent);
    expect(stderrCapture).toContain('tier.subagent');
  });

  test('tier.subagent accepts explicit Anthropic override', async () => {
    stub.set('models.tier.subagent', 'anthropic:claude-opus-4-7');
    const m = await resolveModel(stub as never, {
      tier: 'subagent',
      fallback: 'sonnet',
    });
    expect(m).toBe('anthropic:claude-opus-4-7');
    expect(stderrCapture).toBe('');
  });

  test('isAnthropicProvider matches provider-prefixed and bare claude-* ids', () => {
    expect(isAnthropicProvider('anthropic:claude-sonnet-4-6')).toBe(true);
    expect(isAnthropicProvider('claude-opus-4-7')).toBe(true);
    expect(isAnthropicProvider('openai:gpt-5.5')).toBe(false);
    expect(isAnthropicProvider('gemini-3-pro')).toBe(false);
    expect(isAnthropicProvider('')).toBe(false);
  });

  test('v0.41.20.0: isAnthropicProvider classifies slash-form (subagent-guard fix)', () => {
    // Pre-fix: 'anthropic/claude-sonnet-4-6' had no colon and didn't start
    // with 'claude-' (started with 'anthropic') → returned false → silent
    // subagent-guard bypass → fall back to TIER_DEFAULTS.subagent without
    // honoring the user's explicit slash-form config.
    expect(isAnthropicProvider('anthropic/claude-sonnet-4-6')).toBe(true);
    expect(isAnthropicProvider('anthropic/claude-opus-4-7')).toBe(true);
    // Non-Anthropic slash forms STILL return false (don't accidentally
    // widen the guard).
    expect(isAnthropicProvider('openai/gpt-5')).toBe(false);
    expect(isAnthropicProvider('google/gemini-3-pro')).toBe(false);
    // OpenRouter Anthropic is a proxy route, not the Messages API.
    expect(isAnthropicProvider('openrouter:anthropic/claude-haiku-4.5')).toBe(false);
  });

  test('isOpenRouterAnthropic matches only openrouter:anthropic/… routes', () => {
    expect(isOpenRouterAnthropic('openrouter:anthropic/claude-haiku-4.5')).toBe(true);
    expect(isOpenRouterAnthropic('openrouter:anthropic/claude-sonnet-4.6')).toBe(true);
    expect(isOpenRouterAnthropic('openrouter:openai/gpt-5.2')).toBe(false);
    expect(isOpenRouterAnthropic('openrouter:deepseek/deepseek-chat')).toBe(false);
    expect(isOpenRouterAnthropic('anthropic:claude-sonnet-4-6')).toBe(false);
    expect(isOpenRouterAnthropic('')).toBe(false);
  });

  test('alias-chain conflict: forward + reverse for same id (Codex F6)', async () => {
    // Codex F6: if both forward and reverse aliases exist, depth cap (2)
    // prevents infinite loop. Canonicalization is deterministic — terminates
    // and returns a valid string, no NaN/undefined fall-through.
    stub.set('models.aliases.claude-sonnet-4-6', 'claude-sonnet-5');
    stub.set('models.aliases.claude-sonnet-5', 'claude-sonnet-4-6');
    const result = await resolveAlias(stub as never, 'claude-sonnet-4-6');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('resolveTierDefault — key-aware matrix (injected env used exclusively)', () => {
  test('anthropic-only → anthropic tier defaults (unchanged behavior)', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-test' };
    expect(resolveTierDefault('reasoning', env)).toBe(TIER_DEFAULTS.reasoning);
    expect(resolveTierDefault('utility', env)).toBe(TIER_DEFAULTS.utility);
    expect(resolveTierDefault('deep', env)).toBe(TIER_DEFAULTS.deep);
    expect(resolveTierDefault('subagent', env)).toBe(TIER_DEFAULTS.subagent);
  });

  test('openai-only → recipe-ranked openai tier defaults (no literal pins anywhere)', () => {
    const env = { OPENAI_API_KEY: 'sk-test' };
    const fallback = openaiStaticTierFallback();
    // Behavioral, not literal: the expected ids derive from the openai
    // recipe's chat list through the shared ranking grammar — updating the
    // recipe at a release updates this test's expectations automatically.
    expect(resolveTierDefault('reasoning', env)).toBe(fallback.reasoning);
    expect(resolveTierDefault('utility', env)).toBe(fallback.utility);
    expect(resolveTierDefault('deep', env)).toBe(fallback.deep);
    expect(resolveTierDefault('subagent', env)).toBe(fallback.subagent);
    // Shape sanity: all openai-prefixed, cheap ≠ top unless the recipe list
    // collapses to one family member.
    for (const id of Object.values(fallback)) expect(id.startsWith('openai:')).toBe(true);
  });

  test('both keys → anthropic wins (first table entry; zero change for keyed installs)', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' };
    expect(resolveTierDefault('reasoning', env)).toBe(TIER_DEFAULTS.reasoning);
  });

  test('no keys → TIER_DEFAULTS unchanged (keyless shape preserved)', () => {
    expect(resolveTierDefault('reasoning', {})).toBe(TIER_DEFAULTS.reasoning);
  });

  test('empty-string keys treated absent (#1249 posture)', () => {
    const env = { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' };
    expect(resolveTierDefault('reasoning', env)).toBe(TIER_DEFAULTS.reasoning);
    const openaiOnly = { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: 'sk-test' };
    expect(resolveTierDefault('reasoning', openaiOnly)).toBe(openaiStaticTierFallback().reasoning);
  });

  test('table order is the precedence contract: anthropic first, openai second', () => {
    expect(PROVIDER_TIER_DEFAULTS[0].provider).toBe('anthropic');
    expect(PROVIDER_TIER_DEFAULTS[1].provider).toBe('openai');
  });
});

describe('resolveModelDetailed — sources + key-aware step 7', () => {
  test('tier default resolves key-aware with source tier_default (openai-only env)', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    try {
      const r = await resolveModelDetailed(null, { tier: 'reasoning', fallback: 'sonnet' });
      expect(r.model).toBe(openaiStaticTierFallback().reasoning);
      expect(r.source).toBe('tier_default');
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  test('GBRAIN_MODEL env still beats the key-aware tier default (source env)', async () => {
    process.env.GBRAIN_MODEL = 'haiku';
    process.env.OPENAI_API_KEY = 'sk-test';
    try {
      const r = await resolveModelDetailed(null, { tier: 'reasoning', fallback: 'sonnet' });
      expect(r.model).toBe(DEFAULT_ALIASES.haiku);
      expect(r.source).toBe('env');
    } finally {
      delete process.env.GBRAIN_MODEL;
      delete process.env.OPENAI_API_KEY;
    }
  });

  test('models.tier.<tier> config still beats the key-aware default (source tier_config)', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    try {
      stub.set('models.tier.reasoning', 'opus');
      const r = await resolveModelDetailed(stub as never, { tier: 'reasoning', fallback: 'sonnet' });
      expect(r.model).toBe(DEFAULT_ALIASES.opus);
      expect(r.source).toBe('tier_config');
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  test('config key wins with source config_key; fallback labels fallback', async () => {
    stub.set('facts.extraction_model', 'openai:gpt-4o-mini');
    const withKey = await resolveModelDetailed(stub as never, {
      configKey: 'facts.extraction_model', tier: 'reasoning', fallback: 'sonnet',
    });
    expect(withKey).toEqual({ model: 'openai:gpt-4o-mini', source: 'config_key' });
    const noTier = await resolveModelDetailed(null, { fallback: 'sonnet' });
    expect(noTier.source).toBe('fallback');
    expect(noTier.model).toBe(DEFAULT_ALIASES.sonnet);
  });

  test('subagent + openai-only: returns cache-capable openai without a no-caching warn', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    try {
      const r = await resolveModelDetailed(null, { tier: 'subagent', fallback: 'sonnet' });
      expect(r.model).toBe(openaiStaticTierFallback().subagent);
      expect(stderrCapture).not.toContain('caching');
      const before = stderrCapture.length;
      await resolveModelDetailed(null, { tier: 'subagent', fallback: 'sonnet' });
      expect(stderrCapture.length).toBe(before); // remains warning-free
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });
});

describe('providerKeyReady + resolveEffectiveChatModel (shared runtime/report resolution)', () => {
  const fileCfg = (partial: Partial<GBrainConfig>): GBrainConfig =>
    ({ engine: 'pglite', ...partial }) as GBrainConfig;

  test('providerKeyReady: recipe auth_env drives readiness; bare/unknown ids are not servable', () => {
    expect(providerKeyReady('openai:gpt-5.2', { OPENAI_API_KEY: 'sk-test' })).toBe(true);
    expect(providerKeyReady('openai:gpt-5.2', {})).toBe(false);
    expect(providerKeyReady('claude-sonnet-4-6', { ANTHROPIC_API_KEY: 'x' })).toBe(false); // bare id
    expect(providerKeyReady('not-a-provider:x', { OPENAI_API_KEY: 'sk-test' })).toBe(false);
    // No required keys + a chat touchpoint (the CLI owns auth) → ready.
    expect(providerKeyReady('claude-cli:claude-sonnet-4-6', {})).toBe(true);
    // A keyed/keyless but CHAT-LESS recipe is NOT ready: honoring an
    // embedding-only pin as chat_model would install a model
    // isAvailable('chat') rejects instead of falling back to the key-aware
    // default. (voyage is embedding-only, hence false despite a live key.
    // ollama gained a local chat touchpoint in #4073/#4315, so keyless → ready.)
    expect(providerKeyReady('voyage:voyage-4-large', { VOYAGE_API_KEY: 'x' })).toBe(false);
    expect(providerKeyReady('ollama:llama3', {})).toBe(true);
  });

  test('servable file pin wins (init-era openai pin + live key)', () => {
    const r = resolveEffectiveChatModel(
      fileCfg({ chat_model: 'openai:gpt-5.2', openai_api_key: 'sk-file' }), {});
    expect(r).toEqual({ model: 'openai:gpt-5.2', source: 'file_pin' });
  });

  test('unservable pin falls through to key-aware default with one warn (provider switch)', () => {
    // Stale init-era openai pin, but the only live key is Anthropic.
    const cfg = fileCfg({ chat_model: 'openai:gpt-5.2' });
    const env = { ANTHROPIC_API_KEY: 'sk-ant-test' };
    const r = resolveEffectiveChatModel(cfg, env);
    expect(r).toEqual({ model: TIER_DEFAULTS.reasoning, source: 'tier_default' });
    expect(stderrCapture).toContain('openai:gpt-5.2');
    const before = stderrCapture.length;
    resolveEffectiveChatModel(cfg, env);
    expect(stderrCapture.length).toBe(before); // warned once per pin per process
  });

  test('GBRAIN_MODEL beats the file pin (env_model source)', () => {
    const r = resolveEffectiveChatModel(
      fileCfg({ chat_model: 'openai:gpt-5.2', openai_api_key: 'sk-file' }),
      { GBRAIN_MODEL: 'anthropic:claude-sonnet-4-6' });
    expect(r).toEqual({ model: 'anthropic:claude-sonnet-4-6', source: 'env_model' });
  });

  test('no pin, no env model → key-aware tier default (keyless → anthropic shape)', () => {
    expect(resolveEffectiveChatModel(null, {})).toEqual({
      model: TIER_DEFAULTS.reasoning, source: 'tier_default',
    });
    expect(resolveEffectiveChatModel(null, { OPENAI_API_KEY: 'sk-test' })).toEqual({
      model: openaiStaticTierFallback().reasoning, source: 'tier_default',
    });
  });
});
