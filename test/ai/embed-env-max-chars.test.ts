/**
 * GBRAIN_EMBED_MAX_CHARS — operator-declared per-text char cap for embed().
 *
 * Why: local / self-hosted embedding servers (llama.cpp GGUF such as
 * qwen3-embedding-4b) time out or overflow their context window on very
 * long single inputs. The operator must be able to bound single-input
 * length to their hardware without forking the gateway. Production-
 * validated for ~6 weeks at 2000 against a qwen3-embedding-4b llama-server:
 * a full 17,106-chunk re-embed completed with zero timeouts (vs. repeated
 * timeouts at the default 8000).
 *
 * Complements GBRAIN_EMBED_MAX_BATCH_TOKENS (#3622, test/ai/
 * embed-env-batch-cap.test.ts): that knob bounds the SHAPE of a batch,
 * this one bounds the LENGTH of a single text. Both follow the same
 * cfg.env configure-time snapshot convention (Codex C3) — the gateway
 * never reads process.env at call time; tests pass the knob through
 * configureGateway({env}), hermetic.
 *
 * Coverage:
 *  - env cap set → transport receives texts truncated to the cap
 *  - env cap absent → long texts still truncate at the 8000 default
 *  - invalid env values (0, negative, garbage, empty) → 8000 default
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  embed,
  __setEmbedTransportForTests,
} from '../../src/core/ai/gateway.ts';

afterAll(() => resetGateway());

function fakeEmbeddings(values: string[], dims: number): { embeddings: number[][] } {
  return {
    embeddings: values.map((_, i) =>
      Array.from({ length: dims }, (_, j) => (j === 0 ? i : 0.1)),
    ),
  };
}

const ENV_KEY = 'GBRAIN_EMBED_MAX_CHARS';

function configureOllama(env: Record<string, string | undefined> = {}): void {
  configureGateway({
    embedding_model: 'ollama:nomic-embed-text',
    embedding_dimensions: 768,
    env,
  });
}

describe('GBRAIN_EMBED_MAX_CHARS env cap for per-text truncation', () => {
  beforeEach(() => resetGateway());
  afterEach(() => __setEmbedTransportForTests(null));

  test('env cap set → transport receives texts truncated to the cap', async () => {
    configureOllama({ [ENV_KEY]: '16' });

    const stub = mock(async ({ values }: { values: string[] }) => fakeEmbeddings(values, 768));
    __setEmbedTransportForTests(stub as any);

    const result = await embed(['a'.repeat(100), 'b'.repeat(16)]);

    expect(result).toHaveLength(2);
    expect(stub).toHaveBeenCalledTimes(1);
    const sent = (stub.mock.calls[0]![0] as { values: string[] }).values;
    expect(sent[0]).toHaveLength(16);
    expect(sent[1]).toHaveLength(16);
  });

  test('env cap absent → texts still truncate at the 8000 default', async () => {
    configureOllama({});

    const stub = mock(async ({ values }: { values: string[] }) => fakeEmbeddings(values, 768));
    __setEmbedTransportForTests(stub as any);

    await embed(['a'.repeat(9000)]);

    const sent = (stub.mock.calls[0]![0] as { values: string[] }).values;
    // If the env knob leaked in with a small value, this would be far
    // shorter; 8000 is the byte-truncated ceiling for a 9000-char ASCII text.
    expect(sent[0]).toHaveLength(8000);
  });

  test.each(['0', '-5', 'abc', ''])('invalid env value %j → 8000 default', async (bad) => {
    configureOllama({ [ENV_KEY]: bad });

    const stub = mock(async ({ values }: { values: string[] }) => fakeEmbeddings(values, 768));
    __setEmbedTransportForTests(stub as any);

    await embed(['a'.repeat(9000)]);

    const sent = (stub.mock.calls[0]![0] as { values: string[] }).values;
    expect(sent[0]).toHaveLength(8000);
  });
});
