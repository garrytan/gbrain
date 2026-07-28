/**
 * #94 — `gbrain init --mode claude-code`: Claude Code-native keyless mode.
 *
 * The mode's contract: a Claude Code subscriber gets a working brain with
 * ZERO provider API keys. PGLite engine, no embedding provider (hybrid
 * search's no-embedding-provider path serves keyword + graph + title),
 * chat through the `claude-cli` recipe's OAuth-session subprocess.
 *
 * Pure-function tests; no DB, no gateway state, no process.env mutation
 * (helpers take cfg/env as arguments per CLAUDE.md test isolation rules).
 */
import { describe, test, expect } from 'bun:test';
import {
  seedAIOptionsFromConfig,
  CLAUDE_CODE_DEFAULT_CHAT_MODEL,
  CLAUDE_CODE_DEFAULT_EXPANSION_MODEL,
  detectOllamaEmbedding,
} from '../src/commands/init.ts';
import {
  assertEmbeddingEnabled,
  isKeylessBrain,
  EmbeddingDisabledError,
} from '../src/core/embedding-dim-check.ts';
import { resolveRecipe } from '../src/core/ai/model-resolver.ts';
import type { GBrainConfig } from '../src/core/config.ts';

describe('isKeylessBrain', () => {
  test('claude_code_mode: true → keyless', () => {
    expect(isKeylessBrain({ embedding_disabled: true, claude_code_mode: true })).toBe(true);
  });

  test('deferred setup alone (embedding_disabled without claude_code_mode) is NOT keyless', () => {
    expect(isKeylessBrain({ embedding_disabled: true })).toBe(false);
  });

  test('null / empty config is NOT keyless', () => {
    expect(isKeylessBrain(null)).toBe(false);
    expect(isKeylessBrain({})).toBe(false);
  });

  test('sentinel must be strictly true — junk config values do not enable keyless mode', () => {
    expect(isKeylessBrain({ claude_code_mode: 'yes' as unknown as boolean })).toBe(false);
    expect(isKeylessBrain({ claude_code_mode: 1 as unknown as boolean })).toBe(false);
  });
});

describe('assertEmbeddingEnabled — keyless vs deferred messaging', () => {
  test('claude-code brain refuses embed with the keyless upgrade hint, not the deferred-setup hint', () => {
    let err: unknown;
    try {
      assertEmbeddingEnabled({ embedding_disabled: true, claude_code_mode: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EmbeddingDisabledError);
    const msg = (err as Error).message;
    expect(msg).toContain('Claude Code mode');
    expect(msg).not.toContain('--no-embedding');
  });

  test('deferred-setup brain keeps the original D9 message', () => {
    let err: unknown;
    try {
      assertEmbeddingEnabled({ embedding_disabled: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EmbeddingDisabledError);
    expect((err as Error).message).toContain('--no-embedding');
  });

  test('embedding-enabled brain passes', () => {
    expect(() => assertEmbeddingEnabled({ embedding_disabled: false })).not.toThrow();
    expect(() => assertEmbeddingEnabled(null)).not.toThrow();
  });
});

describe('seedAIOptionsFromConfig — claude-code re-init stability', () => {
  test('claude-code brain re-seeds both noEmbedding and claudeCode', () => {
    const cfg = {
      engine: 'pglite',
      embedding_disabled: true,
      claude_code_mode: true,
      chat_model: CLAUDE_CODE_DEFAULT_CHAT_MODEL,
    } as GBrainConfig;
    const out = seedAIOptionsFromConfig(cfg, {});
    expect(out.noEmbedding).toBe(true);
    expect(out.claudeCode).toBe(true);
    expect(out.chat_model).toBe(CLAUDE_CODE_DEFAULT_CHAT_MODEL);
    expect(out.embedding_model).toBeUndefined();
  });

  test('plain deferred-setup brain seeds noEmbedding only', () => {
    const out = seedAIOptionsFromConfig({ embedding_disabled: true } as GBrainConfig, {});
    expect(out.noEmbedding).toBe(true);
    expect(out.claudeCode).toBeUndefined();
  });
});

describe('claude-cli default chat model — keyless contract', () => {
  test('CLAUDE_CODE_DEFAULT_CHAT_MODEL resolves to the claude-cli recipe', () => {
    const { recipe, parsed } = resolveRecipe(CLAUDE_CODE_DEFAULT_CHAT_MODEL);
    expect(recipe.id).toBe('claude-cli');
    expect(recipe.touchpoints.chat?.models).toContain(parsed.modelId);
  });

  test('claude-cli recipe requires no env vars (the CLI owns auth)', () => {
    const { recipe } = resolveRecipe(CLAUDE_CODE_DEFAULT_CHAT_MODEL);
    expect(recipe.auth_env?.required ?? []).toEqual([]);
  });

  test('claude-cli recipe supports the subagent loop (D7 caveat exemption is sound)', () => {
    const { recipe } = resolveRecipe(CLAUDE_CODE_DEFAULT_CHAT_MODEL);
    expect(recipe.touchpoints.chat?.supports_subagent_loop).toBe(true);
  });

  test('CLAUDE_CODE_DEFAULT_EXPANSION_MODEL resolves to a declared claude-cli expansion model', () => {
    const { recipe, parsed } = resolveRecipe(CLAUDE_CODE_DEFAULT_EXPANSION_MODEL);
    expect(recipe.id).toBe('claude-cli');
    expect(recipe.touchpoints.expansion?.models).toContain(parsed.modelId);
  });
});

describe('detectOllamaEmbedding — keyless local semantic search probe', () => {
  const modelsResponse = (ids: string[]) =>
    ({
      ok: true,
      json: async () => ({ object: 'list', data: ids.map(id => ({ id })) }),
    }) as unknown as Response;

  test('daemon with a known embedding model (tagged id) → ollama model + dims', async () => {
    const fetchStub = (async () => modelsResponse(['llama3.2:latest', 'nomic-embed-text:latest'])) as unknown as typeof fetch;
    const got = await detectOllamaEmbedding({}, fetchStub);
    expect(got).toEqual({ fullModel: 'ollama:nomic-embed-text', dims: 768 });
  });

  test('daemon with only chat models → null (no silent wrong-width column)', async () => {
    const fetchStub = (async () => modelsResponse(['llama3.2:latest', 'qwen2.5-coder:7b'])) as unknown as typeof fetch;
    expect(await detectOllamaEmbedding({}, fetchStub)).toBeNull();
  });

  test('daemon unreachable → null (probe never throws)', async () => {
    const fetchStub = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await detectOllamaEmbedding({}, fetchStub)).toBeNull();
  });

  test('non-OK / malformed responses → null', async () => {
    const bad = (async () => ({ ok: false } as unknown as Response)) as unknown as typeof fetch;
    expect(await detectOllamaEmbedding({}, bad)).toBeNull();
    const junk = (async () => ({ ok: true, json: async () => ({ nope: 1 }) } as unknown as Response)) as unknown as typeof fetch;
    expect(await detectOllamaEmbedding({}, junk)).toBeNull();
  });

  test('OLLAMA_BASE_URL is honored', async () => {
    let seenUrl = '';
    const fetchStub = (async (url: string | URL) => {
      seenUrl = String(url);
      return modelsResponse(['bge-m3:latest']);
    }) as unknown as typeof fetch;
    const got = await detectOllamaEmbedding({ OLLAMA_BASE_URL: 'http://10.0.0.5:11434/v1' }, fetchStub);
    expect(seenUrl).toBe('http://10.0.0.5:11434/v1/models');
    expect(got?.fullModel).toBe('ollama:bge-m3');
  });
});
