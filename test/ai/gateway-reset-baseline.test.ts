/**
 * #3554 — resetGateway() must restore the test baseline, not unconfigure.
 *
 * The bunfig preload (test/helpers/legacy-embedding-preload.ts) pins the
 * gateway to openai:text-embedding-3-large @ 1536 at process start and
 * registers that config as the reset baseline. Before the fix,
 * resetGateway() wiped the pin to _config = null; the next file's beforeAll
 * engine-connect then reconfigured from the SHIPPED default (zembed-1 @
 * 1280) and every 1536-d fixture in that file failed with
 * `expected 1280 dimensions, not 1536`. Which file pairs collided depended
 * on shard bin-packing, so adding ANY test file reshuffled the mines.
 *
 * These assertions pin the contract so it cannot silently rot again.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  __unconfigureGatewayForTests,
  __setChatTransportForTests,
  getEmbeddingModel,
  getEmbeddingDimensions,
  isAvailable,
} from '../../src/core/ai/gateway.ts';

afterEach(() => resetGateway());

describe('resetGateway baseline restore (#3554)', () => {
  test('immediately after resetGateway(), the preload baseline is live', () => {
    resetGateway();
    expect(getEmbeddingModel()).toBe('openai:text-embedding-3-large');
    expect(getEmbeddingDimensions()).toBe(1536);
  });

  test('resetGateway() overwrites a file-local config back to the baseline', () => {
    configureGateway({
      embedding_model: 'zeroentropyai:zembed-1',
      embedding_dimensions: 1280,
      env: {},
    });
    expect(getEmbeddingDimensions()).toBe(1280);
    resetGateway();
    expect(getEmbeddingModel()).toBe('openai:text-embedding-3-large');
    expect(getEmbeddingDimensions()).toBe(1536);
  });

  test('resetGateway() still clears test transports (no stale transport leaks back)', () => {
    __setChatTransportForTests(async () => {
      throw new Error('should have been cleared');
    });
    resetGateway();
    // Baseline config sets no chat key in a keyless env, but the transport
    // seam itself must be gone: isAvailable('chat') short-circuits to true
    // whenever a chat transport is installed, so with a hard-unconfigured
    // gateway it can only be true if the transport survived the reset.
    __unconfigureGatewayForTests();
    expect(isAvailable('chat')).toBe(false);
  });

  test('__unconfigureGatewayForTests() gives a genuinely unconfigured gateway', () => {
    __unconfigureGatewayForTests();
    expect(() => getEmbeddingDimensions()).toThrow(/not configured/);
    expect(isAvailable('embedding')).toBe(false);
    // And a plain reset brings the baseline back.
    resetGateway();
    expect(getEmbeddingDimensions()).toBe(1536);
  });
});
