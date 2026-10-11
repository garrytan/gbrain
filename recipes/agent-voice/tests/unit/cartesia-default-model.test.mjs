/**
 * cartesia-default-model.test.mjs — #5905: Cartesia retired `sonic-english`
 * on 2026-06-01; the adapter's default must be a current model. String-only:
 * the adapter is constructed, never asked to speak, and fetch is replaced by
 * a counter that must stay at zero.
 *
 * Not in install/manifest.json: `code/pipeline.mjs` is the deferred DIY
 * pipeline and is not copied to host repos, so this test stays gbrain-side.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CARTESIA_DEFAULT_MODEL_ID, CartesiaTtsAdapter } from '../../code/pipeline.mjs';

describe('Cartesia TTS default model (#5905)', () => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  beforeEach(() => { calls = 0; globalThis.fetch = async () => { calls++; throw new Error('no TTS calls in this test'); }; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('defaults to sonic-3.6, never sonic-english, and makes no TTS call', () => {
    const tts = new CartesiaTtsAdapter({ apiKey: 'test-key' });
    expect(CARTESIA_DEFAULT_MODEL_ID).toBe('sonic-3.6');
    expect(tts.modelId).toBe('sonic-3.6');
    expect(tts.modelId).not.toBe('sonic-english');
    expect(calls).toBe(0);
  });

  it('an explicit modelId still wins', () => {
    const tts = new CartesiaTtsAdapter({ apiKey: 'test-key', modelId: 'sonic-3.5' });
    expect(tts.modelId).toBe('sonic-3.5');
    expect(calls).toBe(0);
  });
});
