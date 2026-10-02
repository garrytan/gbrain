/**
 * #5735: the corpus-harvest gates ask whether the extraction model GBrain
 * will actually use is servable — the engine-resolved model (DB-plane
 * `facts.extraction_model` included) checked against the configured
 * gateway — instead of the engine-blind detectCapabilities() file/env probe.
 * An explicit capability report (caller or test seam) still wins.
 *
 * No chat transport stub here: the stub makes isAvailable('chat') true for
 * every model and would hide which model the helper resolved.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __unconfigureGatewayForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { RECIPES } from '../src/core/ai/recipes/index.ts';
import { detectCapabilities, type CapabilityReport } from '../src/core/capability.ts';
import {
  extractionAvailableForEngine,
  resolveExtractionAvailability,
} from '../src/core/facts/extraction-availability.ts';
import { withEnv, emptyHome } from './helpers/with-env.ts';

const KEYLESS: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: false },
  search: 'keyword-only',
  mode: 'keyless',
};
const KEYED: CapabilityReport = { ...KEYLESS, extraction: { available: true, provider: 'anthropic' }, mode: 'keyed' };

const noProviderKeys = Object.fromEntries(
  Array.from(new Set(Array.from(RECIPES.values()).flatMap((r) => r.auth_env?.required ?? [])), (k) => [k, undefined]),
);

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

afterEach(async () => {
  resetGateway();
  await engine.unsetConfig('facts.extraction_model');
});

describe('extractionAvailableForEngine (#5735)', () => {
  test('a DB-plane local model is available on a keyless file/env plane', async () => {
    await withEnv({ ...noProviderKeys, GBRAIN_HOME: emptyHome() }, async () => {
      await engine.setConfig('facts.extraction_model', 'ollama:qwen2.5-coder:14b');
      configureGateway({ env: {} });
      expect(detectCapabilities().extraction.available).toBe(false);
      expect(await extractionAvailableForEngine(engine)).toBe(true);
      expect(await resolveExtractionAvailability(engine)).toEqual({
        model: 'ollama:qwen2.5-coder:14b',
        available: true,
      });
    });
  });

  test('a keyed default model with no key stays unavailable', async () => {
    await withEnv({ ...noProviderKeys, GBRAIN_HOME: emptyHome() }, async () => {
      configureGateway({ env: {} });
      const r = await resolveExtractionAvailability(engine);
      expect(r.available).toBe(false);
      expect(await extractionAvailableForEngine(engine)).toBe(false);
    });
  });

  test('an unconfigured gateway is unavailable, never a throw', async () => {
    await engine.setConfig('facts.extraction_model', 'ollama:qwen2.5-coder:14b');
    __unconfigureGatewayForTests();
    expect(await extractionAvailableForEngine(engine)).toBe(false);
  });

  test('an explicit capability report wins in both directions', async () => {
    await engine.setConfig('facts.extraction_model', 'ollama:qwen2.5-coder:14b');
    configureGateway({ env: {} });
    expect(await extractionAvailableForEngine(engine, KEYLESS)).toBe(false);
    __unconfigureGatewayForTests();
    expect(await extractionAvailableForEngine(engine, KEYED)).toBe(true);
  });

  test('a caller-pinned model is checked instead of the engine resolution', async () => {
    await engine.setConfig('facts.extraction_model', 'ollama:qwen2.5-coder:14b');
    await withEnv({ ...noProviderKeys }, async () => {
      configureGateway({ env: {} });
      expect(await resolveExtractionAvailability(engine, 'anthropic:claude-sonnet-4-6')).toEqual({
        model: 'anthropic:claude-sonnet-4-6',
        available: false,
      });
    });
  });
});
