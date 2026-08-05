import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { EmbedOpts, EmbedResult } from '../src/commands/embed.ts';
import { buildEmbedBackgroundJobData, parsePaceArgs } from '../src/commands/embed.ts';
import { resolveEmbedJobData, runEmbedJob } from '../src/commands/jobs.ts';

function embedResult(overrides: Partial<EmbedResult> = {}): EmbedResult {
  return {
    embedded: 2,
    skipped: 0,
    would_embed: 0,
    total_chunks: 2,
    pages_processed: 1,
    failures: 0,
    failure_samples: [],
    dryRun: false,
    ...overrides,
  };
}

describe('resolveEmbedJobData', () => {
  test('forwards the explicit NULL-signature migration flag', () => {
    expect(resolveEmbedJobData({
      stale: true,
      sourceId: 'default',
      includeNullSignature: true,
    })).toEqual({
      slug: undefined,
      slugs: undefined,
      all: false,
      stale: true,
      sourceId: 'default',
      includeNullSignature: true,
    });
  });

  test('rejects malformed booleans before they can widen the target', () => {
    for (const value of ['false', 0, null, {}]) {
      expect(() => resolveEmbedJobData({ all: value })).toThrow('data.all must be a boolean');
    }
    expect(() => resolveEmbedJobData({ dryRun: 'true' })).toThrow('data.dryRun must be a boolean');
    expect(() => resolveEmbedJobData({ includeNullSignature: 'true' })).toThrow('data.includeNullSignature must be a boolean');
  });

  test('rejects empty source and mixed-type slug targets', () => {
    expect(() => resolveEmbedJobData({ sourceId: '' })).toThrow('data.sourceId must be a non-empty string');
    expect(() => resolveEmbedJobData({ slugs: ['ok', 42] })).toThrow('data.slugs must be a non-empty array');
  });

  test('preserves all-mode and background pace semantics', () => {
    expect(resolveEmbedJobData({
      all: true,
      stale: true,
      pace: {
        perCallMode: 'Gentle',
        perCall: {
          enabled: true,
          maxConcurrency: 4,
          paceAtMs: 250,
          maxSleepMs: 2_000,
          ewmaAlpha: 0.3,
        },
      },
    })).toEqual({
      slug: undefined,
      slugs: undefined,
      all: true,
      stale: false,
      sourceId: undefined,
      pace: {
        perCallMode: 'gentle',
        perCall: {
          enabled: true,
          maxConcurrency: 4,
          paceAtMs: 250,
          maxSleepMs: 2_000,
          ewmaAlpha: 0.3,
        },
      },
      paceFromBackground: true,
    });
  });

  test('rejects malformed nested pace payloads', () => {
    expect(() => resolveEmbedJobData({ pace: null })).toThrow('data.pace must be an object');
    expect(() => resolveEmbedJobData({ pace: { perCallMode: 42 } })).toThrow('perCallMode must be a pace mode');
    expect(() => resolveEmbedJobData({ pace: { perCallMode: 'turbo' } })).toThrow('perCallMode must be one of');
    expect(() => resolveEmbedJobData({ pace: { extra: true } })).toThrow('pace.extra is not supported');
    expect(() => resolveEmbedJobData({ pace: { perCall: { enabled: 'false' } } })).toThrow('enabled must be a boolean');
    expect(() => resolveEmbedJobData({ pace: { perCall: { maxConcurrency: '8' } } })).toThrow('maxConcurrency must be an integer');
    expect(() => resolveEmbedJobData({ pace: { perCall: { maxConcurrency: 257 } } })).toThrow('maxConcurrency must be an integer');
    expect(() => resolveEmbedJobData({ pace: { perCall: { paceAtMs: -1 } } })).toThrow('paceAtMs must be an integer');
    expect(() => resolveEmbedJobData({ pace: { perCall: { maxSleepMs: 1.5 } } })).toThrow('maxSleepMs must be an integer');
    expect(() => resolveEmbedJobData({ pace: { perCall: { ewmaAlpha: 0 } } })).toThrow('ewmaAlpha must be a number');
    expect(() => resolveEmbedJobData({ pace: { perCall: { unknown: 1 } } })).toThrow('perCall.unknown is not supported');
  });
});

describe('buildEmbedBackgroundJobData', () => {
  test('serializes the documented NULL-signature catch-up command completely', () => {
    expect(buildEmbedBackgroundJobData([
      '--stale',
      '--catch-up',
      '--include-null-signature',
      '--dry-run',
      '--source', 'default',
      '--batch-size', '250',
      '--priority', 'recent',
      '--pace=gentle',
    ])).toEqual({
      all: false,
      stale: true,
      dryRun: true,
      sourceId: 'default',
      batchSize: 250,
      priority: 'recent',
      catchUp: true,
      includeNullSignature: true,
      pace: { perCallMode: 'gentle' },
    });
  });

  test('keeps option values out of --slugs and preserves a positional target', () => {
    expect(buildEmbedBackgroundJobData([
      '--slugs', 'one', 'two', '--source', 'default', '--batch-size', '50',
    ])).toMatchObject({ slugs: ['one', 'two'], sourceId: 'default', batchSize: 50 });
    expect(buildEmbedBackgroundJobData(['people/alice', '--source', 'default'])).toMatchObject({
      slug: 'people/alice',
      sourceId: 'default',
    });
  });
});

describe('parsePaceArgs', () => {
  test('uses the same mode and concurrency validation for foreground and background', () => {
    expect(parsePaceArgs(['--pace=Gentle', '--pace-max-concurrency', '256'])).toEqual({
      perCallMode: 'gentle',
      perCall: { maxConcurrency: 256 },
    });
    expect(() => parsePaceArgs(['--pace=turbo'])).toThrow('--pace must be one of');
    expect(() => parsePaceArgs(['--pace-max-concurrency=257'])).toThrow('integer in [1, 256]');
    expect(() => parsePaceArgs(['--pace-max-concurrency', '8junk'])).toThrow('integer in [1, 256]');
  });
});

describe('runEmbedJob', () => {
  test('round-trips the complete payload, trusted cancellation signal, and real result', async () => {
    const controller = new AbortController();
    const expected = embedResult();
    let received: EmbedOpts | undefined;
    const runner = async (_engine: BrainEngine, opts: EmbedOpts): Promise<EmbedResult> => {
      received = opts;
      return expected;
    };

    const result = await runEmbedJob(
      {} as BrainEngine,
      buildEmbedBackgroundJobData([
        '--stale', '--dry-run', '--catch-up', '--include-null-signature', '--source', 'default',
      ]),
      { signal: controller.signal, onProgress: () => {} },
      runner,
    );

    expect(result).toBe(expected);
    expect(received).toMatchObject({
      stale: true,
      dryRun: true,
      catchUp: true,
      includeNullSignature: true,
      sourceId: 'default',
      signal: controller.signal,
    });
  });

  test('turns partial embedding failures into a retryable failed job', async () => {
    const runner = async (): Promise<EmbedResult> => embedResult({
      failures: 1,
      failure_samples: ['people/alice: provider timeout'],
    });

    await expect(runEmbedJob(
      {} as BrainEngine,
      { stale: true },
      { signal: new AbortController().signal, onProgress: () => {} },
      runner,
    )).rejects.toThrow('embed job left 1 failed chunk(s): people/alice: provider timeout');
  });
});
