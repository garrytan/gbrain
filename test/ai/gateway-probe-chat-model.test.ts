/**
 * #1698 — validateModelId (C1 id-validity core) + probeChatModel (= validity + key).
 *
 * validateModelId reads the recipe REGISTRY (not gateway _config), so it works without
 * configureGateway — that's the property makeJudgeClient + tryBuildGatewayClient rely on
 * (C1 #6). probeChatModel adds the key layer via hasAnthropicKey (env OR gbrain config
 * file — also gateway-config-independent). Non-Anthropic providers pass the probe (lazy
 * key check deferred to gateway.chat).
 *
 * Hermetic: key-sensitive cases isolate env + GBRAIN_HOME via withEnv (R1) so the dev
 * machine's real ~/.gbrain/config.json never leaks in.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateModelId, probeChatModel, configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { probeChatModelWithKey } from '../../src/core/ai/chat-key-probe.ts';
import { normalizeModelId } from '../../src/core/model-id.ts';
import { withEnv } from '../helpers/with-env.ts';

const REAL = 'anthropic:claude-sonnet-4-6';

const tmpDirs: string[] = [];
function emptyHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'gbrain-probe-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// No-key env: ANTHROPIC_API_KEY unset + GBRAIN_HOME pointed at an empty dir so the
// config-file branch of hasAnthropicKey finds nothing.
const noKeyEnv = () => ({ ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: emptyHome() });
const withKeyEnv = () => ({ ANTHROPIC_API_KEY: 'sk-test', GBRAIN_HOME: emptyHome() });

describe('validateModelId (#1698 C1 core)', () => {
  test('ok for a real model id, returns parsed + recipe', () => {
    const v = validateModelId(REAL);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.parsed.providerId).toBe('anthropic');
      expect(v.recipe).toBeDefined();
    }
  });

  test('works WITHOUT configureGateway (reads registry, not _config) — C1 #6 guard', () => {
    // No gateway configured in this process; validateModelId must still resolve.
    const v = validateModelId(REAL);
    expect(v.ok).toBe(true);
  });

  test('unknown_provider when resolveRecipe throws', () => {
    const v = validateModelId('bogusprovider:whatever');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('unknown_provider');
  });

  test('ok for an unlisted native model (no runtime allowlist — provider decides)', () => {
    expect(validateModelId('anthropic:claude-bogus-9').ok).toBe(true);
    expect(validateModelId('openai:gpt-5.6-sol').ok).toBe(true);
  });

  test('unknown_model when the provider lacks the touchpoint entirely', () => {
    const v = validateModelId('voyage:voyage-3', 'chat');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('unknown_model');
  });
});

describe('probeChatModel (#1698 = validity + key, config-independent)', () => {
  test('unavailable: anthropic + no key', async () => {
    await withEnv(noKeyEnv(), async () => {
      const p = probeChatModel(REAL);
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.reason).toBe('unavailable');
    });
  });

  test('ok: anthropic + key set (no configureGateway needed)', async () => {
    await withEnv(withKeyEnv(), async () => {
      expect(probeChatModel(REAL).ok).toBe(true);
    });
  });

  test('unknown_provider / unknown_model classify regardless of key (validity runs first)', async () => {
    await withEnv(withKeyEnv(), async () => {
      expect(probeChatModel('bogusprovider:x')).toMatchObject({ ok: false, reason: 'unknown_provider' });
      // unknown_model now fires only for a missing touchpoint (voyage has no
      // chat); unlisted ids on chat-capable providers pass local validation.
      expect(probeChatModel('voyage:voyage-3')).toMatchObject({ ok: false, reason: 'unknown_model' });
      expect(probeChatModel('anthropic:claude-bogus-9').ok).toBe(true);
    });
  });

  test('non-anthropic provider passes the probe even with no key (lazy key check)', async () => {
    // deepseek is a registered recipe; its key check is deferred to gateway.chat()
    // (the per-transcript-degrade contract — A9). probe should be ok here.
    await withEnv(noKeyEnv(), async () => {
      expect(probeChatModel('deepseek:deepseek-chat').ok).toBe(true);
    });
  });

  test('reported repro: slash form normalizes then probes ok (with key)', async () => {
    await withEnv(withKeyEnv(), async () => {
      expect(probeChatModel(normalizeModelId('anthropic/claude-sonnet-4-6')).ok).toBe(true);
    });
  });
});

// #2119 read-side: a DB-plane anthropic_api_key reaches the gateway env via
// loadConfigWithEngine → buildGatewayConfig → configureGateway, which stashes
// it into the anthropic-key snapshot. probeChatModel (gateway-config-
// independent by design) must see it — precedence env > snapshot > file.
describe('probeChatModel gateway-env snapshot (#2119)', () => {
  test('DB-plane-merged key in the gateway env satisfies the probe; reset clears it', async () => {
    try {
      await withEnv(noKeyEnv(), async () => {
        // Simulates connectEngine's boot fold after the DB merge: the merged
        // config carried anthropic_api_key, so the gateway env has it even
        // though process.env and the config file do not.
        configureGateway({ env: { ANTHROPIC_API_KEY: 'sk-db-plane' } });
        expect(probeChatModel(REAL).ok).toBe(true);
        // Reset returns to the preload baseline (fresh process.env capture,
        // still scrubbed here) — the stash must not outlive the config that
        // installed it.
        resetGateway();
        const p = probeChatModel(REAL);
        expect(p.ok).toBe(false);
        if (!p.ok) expect(p.reason).toBe('unavailable');
      });
    } finally {
      resetGateway(); // re-capture the real process env into the baseline
    }
  });

  test('env-verbatim keys are NOT stashed — a hermetic env scrub still wins', async () => {
    try {
      await withEnv({ ANTHROPIC_API_KEY: 'sk-proc', GBRAIN_HOME: emptyHome() }, async () => {
        // Preload-shaped fold: env captured wholesale. The key came verbatim
        // from process.env, so the snapshot must stay empty.
        configureGateway({ env: { ...process.env } });
      });
      await withEnv(noKeyEnv(), async () => {
        // Env scrubbed, file empty, snapshot deliberately not populated →
        // the probe honestly reports no key despite the configured gateway
        // env still carrying sk-proc.
        const p = probeChatModel(REAL);
        expect(p.ok).toBe(false);
        if (!p.ok) expect(p.reason).toBe('unavailable');
      });
    } finally {
      resetGateway();
    }
  });
});

describe('probeChatModelWithKey (provider-agnostic key check, #6705)', () => {
  const noOpenAiKey = () => ({ OPENAI_API_KEY: undefined, GBRAIN_HOME: emptyHome() });

  test('unavailable: keyed non-Anthropic provider with no key names the env var and its config key', async () => {
    await withEnv(noOpenAiKey(), async () => {
      expect(probeChatModelWithKey('openai:gpt-5.6')).toEqual({
        ok: false, reason: 'unavailable',
        detail: 'no OpenAI API key configured (set OPENAI_API_KEY or run: gbrain config set openai_api_key ...)',
      });
    });
  });

  test('a provider with no config-file key names only the env var', async () => {
    await withEnv({ MINIMAX_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      const p = probeChatModelWithKey('minimax:MiniMax-M2.7');
      expect(p.ok).toBe(false);
      if (!p.ok) {
        expect(p.detail).toContain('set MINIMAX_API_KEY)');
        expect(p.detail).not.toContain('gbrain config set');
      }
    });
  });

  test('ok: keyed non-Anthropic provider with the key in env', async () => {
    await withEnv({ OPENAI_API_KEY: 'sk-test', GBRAIN_HOME: emptyHome() }, async () => {
      expect(probeChatModelWithKey('openai:gpt-5.6').ok).toBe(true);
    });
  });

  test('ok: key present only in the gateway env snapshot', async () => {
    await withEnv(noOpenAiKey(), async () => {
      configureGateway({ chat_model: 'openai:gpt-5.6', env: { OPENAI_API_KEY: 'sk-test' } });
      try {
        expect(probeChatModelWithKey('openai:gpt-5.6').ok).toBe(true);
      } finally {
        resetGateway();
      }
    });
  });

  test('ok: a local recipe with no declared key passes keyless', async () => {
    await withEnv(noOpenAiKey(), async () => {
      expect(probeChatModelWithKey('ollama:qwen2.5-coder:14b').ok).toBe(true);
    });
  });

  test('anthropic keeps probeChatModel\'s answer', async () => {
    await withEnv(noKeyEnv(), async () => {
      expect(probeChatModelWithKey(REAL)).toEqual(probeChatModel(REAL));
      expect(probeChatModelWithKey(REAL).ok).toBe(false);
    });
  });

  test('validity still runs first: unknown provider classifies regardless of keys', () => {
    const p = probeChatModelWithKey('bogusprovider:whatever');
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toBe('unknown_provider');
  });

  test('probeChatModel keeps its lazy non-Anthropic contract (A9)', async () => {
    await withEnv(noOpenAiKey(), async () => {
      expect(probeChatModel('openai:gpt-5.6').ok).toBe(true);
    });
  });
});
