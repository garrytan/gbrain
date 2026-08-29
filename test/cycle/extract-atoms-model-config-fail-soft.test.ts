// Regression pin for a bug introduced (and caught in review) while extracting
// the model-resolution logic into the shared `resolveExtractAtomsModel()`
// (see `resolveExtractAtomsModel` in extract-atoms.ts).
//
// `runPhaseExtractAtoms` deliberately wraps ALL of its per-run config reads
// (models.dream.extract_atoms, cycle.extract_atoms.budget_usd,
// max_input_chars, max_output_tokens, pacing_ms) in a single try/catch whose
// comment says: "Keep safe defaults on any config-read failure: key-aware
// utility-tier model, $0.30 cap, default max_source_chars." A first version
// of the resolver refactor moved the extract_atoms model read OUTSIDE that
// try block, so a throwing `engine.getConfig()` would reject the whole phase
// instead of falling back to `resolveTierDefault('utility')`. This test
// exercises exactly that: `getConfig` throws for every key, and the phase
// must still complete (using the tier-default model) rather than throw.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { resolveTierDefault } from '../../src/core/model-config.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function captureChat(): { calls: ChatOpts[]; chat: (o: ChatOpts) => Promise<ChatResult> } {
  const calls: ChatOpts[] = [];
  return {
    calls,
    chat: async (o: ChatOpts) => {
      calls.push(o);
      return {
        text: '[]',
        blocks: [{ type: 'text', text: '[]' }],
        stopReason: 'end',
        usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5',
        providerId: 'anthropic',
      };
    },
  };
}

describe('extract_atoms model resolution stays fail-soft on a throwing config read', () => {
  test('a throwing getConfig does not reject the phase — falls back to the tier default', async () => {
    const { calls, chat } = captureChat();
    // Wrap the real engine so every getConfig() throws, mirroring the
    // "on any config-read failure" scenario the try/catch is meant to
    // absorb, without hand-rolling a full BrainEngine stub.
    const throwingEngine = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'getConfig') {
          return async () => {
            throw new Error('simulated config-read failure');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const result = await runPhaseExtractAtoms(throwingEngine as unknown as PGLiteEngine, {
      sourceId: 'default',
      _transcripts: [{ filePath: '/tmp/fail-soft.txt', content: 'hello world', contentHash: 'h1'.repeat(8) }],
      _pages: [],
      _chat: chat,
    });

    // Must complete, not throw/reject.
    expect(result.phase).toBe('extract_atoms');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.model).toBe(resolveTierDefault('utility'));
  });
});
