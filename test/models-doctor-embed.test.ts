/**
 * v0.40.x — `gbrain models doctor` embedding reachability probe.
 *
 * The probe sends one real `embed(['probe'])` as a query with an abort signal
 * (embedQuery takes no signal) and reports a distinct
 * `embedding_reachability` row; runModels runs it only when the zero-network
 * embedding config probe passed, so a config failure is not reported twice.
 * The embed transport is injected and fetch is stubbed offline; chat probes are
 * skipped with --skip=anthropic.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { probeEmbeddingReachability, runModels } from '../src/commands/models.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';

type EmbedFn = typeof import('../src/core/ai/gateway.ts').embed;
type EmbedManyFn = Parameters<typeof __setEmbedTransportForTests>[0];

afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

const stubEngine = { getConfig: async () => null, getPage: async () => ({ source_id: 'default' }) };

async function doctor(embeddingModel: string, dims: number): Promise<{ probes: Array<{ touchpoint: string; status: string }>; embedCalls: number }> {
  configureGateway({
    embedding_model: embeddingModel,
    embedding_dimensions: dims,
    chat_model: 'anthropic:claude-sonnet-5',
    expansion_model: 'anthropic:claude-haiku-4-5',
    env: { OPENAI_API_KEY: 'test-key', VOYAGE_API_KEY: 'test-key' },
  });
  let embedCalls = 0;
  __setEmbedTransportForTests((async (opts: { values: string[] }) => {
    embedCalls++;
    return { embeddings: opts.values.map(() => new Array(dims).fill(0.1)), usage: { tokens: 1 } };
  }) as unknown as EmbedManyFn);
  let stdout = '';
  const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }) as never);
  const stderr = spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const offline = spyOn(globalThis, 'fetch').mockImplementation((async () => { throw new Error('offline'); }) as never);
  try {
    await runModels(stubEngine as never, ['doctor', '--json', '--skip=anthropic']);
  } finally {
    write.mockRestore(); stderr.mockRestore(); exit.mockRestore(); offline.mockRestore();
  }
  return { probes: JSON.parse(stdout).probes, embedCalls };
}

describe('models doctor — embedding reachability probe (v0.40.x)', () => {
  test('sends one query-typed embed with an abort signal and reports embedding_reachability', async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test-key' } });
    const calls: Array<{ texts: string[]; opts: Record<string, unknown> }> = [];
    const embed = (async (texts: string[], opts: Record<string, unknown>) => { calls.push({ texts, opts }); return [new Float32Array(1536)]; }) as unknown as EmbedFn;
    const ok = await probeEmbeddingReachability({ embed });
    expect(calls).toHaveLength(1);
    expect(calls[0].texts).toEqual(['probe']);
    expect(calls[0].opts.inputType).toBe('query');
    expect(calls[0].opts.abortSignal).toBeInstanceOf(AbortSignal);
    expect(ok).toMatchObject({ touchpoint: 'embedding_reachability', status: 'ok' });

    const failing = (async () => { throw new Error('401 Unauthorized'); }) as unknown as EmbedFn;
    expect(await probeEmbeddingReachability({ embed: failing, fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch }))
      .toMatchObject({ touchpoint: 'embedding_reachability', status: 'auth' });
  });

  test('runModels probes reachability once when the embedding config is valid', async () => {
    const { probes, embedCalls } = await doctor('openai:text-embedding-3-small', 1536);
    expect(probes.find(p => p.touchpoint === 'embedding_config')?.status).toBe('ok');
    expect(probes.filter(p => p.touchpoint === 'embedding_reachability')).toEqual([expect.objectContaining({ status: 'ok' })]);
    expect(embedCalls).toBe(1);
  });

  test('runModels skips the reachability probe when the embedding config probe fails', async () => {
    const { probes, embedCalls } = await doctor('voyage:voyage-4', 999);
    expect(probes.find(p => p.touchpoint === 'embedding_config')?.status).toBe('config');
    expect(probes.some(p => p.touchpoint === 'embedding_reachability')).toBe(false);
    expect(embedCalls).toBe(0);
  });
});
