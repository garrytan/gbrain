/**
 * PR #5347 takeover ([R13]) — a chunk the embedder rejects as too long for a
 * model that declares NO `max_input_tokens` must be split, not retried
 * forever and not parked.
 *
 * Master's heal (`healOversizedPageChunks`) splits stored chunks to the
 * ACTIVE model's cap, but with no declared cap that is the 2000-token
 * default — the provider's 400 ("input length exceeds the context length")
 * comes back on every sweep and the page never embeds. The fix derives a
 * deterministic smaller cap from the failure (the limit the message names ×
 * EMBED_INPUT_SAFETY, else half the largest failed text's estimate), learns
 * it for the model for the rest of the process so later heals split the
 * same way, runs the heal on that page at once, and stops after a finite
 * number of attempts or below a minimum useful cap with an explicit terminal
 * outcome. Unrelated 400s never rewrite a chunk.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installPageProjection, readProjectionSnapshot } from '../src/core/page-state/projections.ts';
import {
  isSingleInputOverLengthError,
  overLengthLimitFromMessage,
  deriveOverLengthChunkCap,
  healPageAfterOverLength,
  describeOverLengthOutcome,
  statusFromCause,
  MIN_USEFUL_CHUNK_TOKENS,
  MAX_OVERLENGTH_HEAL_ATTEMPTS,
  _resetOverLengthHealForTest,
} from '../src/core/embed-overlength-heal.ts';
import {
  resolveMaxChunkTokens,
  learnedChunkCap,
  _resetLearnedChunkCapsForTest,
} from '../src/core/embedding-input-limit.ts';
import { DEFAULT_MAX_CHUNK_TOKENS, estimateEmbedTokens } from '../src/core/chunkers/token-estimate.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

/** A local recipe with no per-input declaration: the case this fix exists for. */
const UNDECLARED_MODEL = 'ollama:nomic-embed-text';

function http(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function fatParagraph(n: number): string {
  const para =
    'The quarterly operating review covers hiring plans, infrastructure spend, customer renewals and the product roadmap for the next two quarters in considerable detail. ';
  return Array.from({ length: n }, () => para).join('\n\n');
}

const withoutChunkTokenEnv = <T>(fn: () => T | Promise<T>) =>
  withEnv({ GBRAIN_MAX_CHUNK_TOKENS: undefined }, fn);

beforeEach(() => {
  resetGateway();
  _resetOverLengthHealForTest();
  _resetLearnedChunkCapsForTest();
  configureGateway({ embedding_model: UNDECLARED_MODEL, embedding_dimensions: 768, env: {} });
});

afterAll(() => {
  resetGateway();
  _resetOverLengthHealForTest();
  _resetLearnedChunkCapsForTest();
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { ...process.env } });
});

describe('recognising a single-input over-length rejection', () => {
  test('provider shapes seen in the field are recognised at 400/413/422', () => {
    expect(isSingleInputOverLengthError(http(400, 'Input length 1460 exceeds maximum allowed token size 512'))).toBe(true);
    expect(isSingleInputOverLengthError(http(400, 'input length exceeds the context length'))).toBe(true);
    expect(isSingleInputOverLengthError(http(400, "This model's maximum context length is 8192 tokens, however you requested 9211 tokens (9211 in your prompt; 0 for the completion). Please reduce your prompt; or completion length."))).toBe(true);
    expect(isSingleInputOverLengthError(http(400, 'Range of input length should be [1, 2048]'))).toBe(true);
    expect(isSingleInputOverLengthError(http(413, 'Payload too large: text exceeds the model limit of 2048 tokens'))).toBe(true);
    expect(isSingleInputOverLengthError(http(422, 'Input text is too long for this model'))).toBe(true);
  });

  test('the status is read through the cause chain, like the fan-out does', () => {
    const wrapped = new Error('embed failed', { cause: http(400, 'input length exceeds the context length') });
    expect(statusFromCause(wrapped)).toBe(400);
    expect(isSingleInputOverLengthError(wrapped)).toBe(true);
  });

  test('batch-level token errors, other 400s, transport errors and rate limits are NOT over-length chunks', () => {
    expect(isSingleInputOverLengthError(http(400, 'Too many tokens overall, split into more batches.'))).toBe(false);
    expect(isSingleInputOverLengthError(http(400, "Invalid 'input': maximum request size is 300000 tokens per request."))).toBe(false);
    expect(isSingleInputOverLengthError(http(400, 'max allowed tokens per batch is 120000'))).toBe(false);
    expect(isSingleInputOverLengthError(http(400, 'Incorrect API key provided'))).toBe(false);
    expect(isSingleInputOverLengthError(http(400, 'model not found: nomic-embed-text'))).toBe(false);
    expect(isSingleInputOverLengthError(http(404, 'input length exceeds the context length'))).toBe(false);
    expect(isSingleInputOverLengthError(http(500, 'input length exceeds the context length'))).toBe(false);
    expect(isSingleInputOverLengthError(http(429, 'rate limit exceeded; token limit exceeded for the minute'))).toBe(false);
    expect(isSingleInputOverLengthError(new Error('input length exceeds the context length'))).toBe(false);
    expect(isSingleInputOverLengthError(null)).toBe(false);
  });

  test('the limit the message names is parsed; prose without a limit yields undefined', () => {
    expect(overLengthLimitFromMessage('Input length 1460 exceeds maximum allowed token size 512')).toBe(512);
    expect(overLengthLimitFromMessage("This model's maximum context length is 8192 tokens, however you requested 9211 tokens")).toBe(8192);
    expect(overLengthLimitFromMessage('Range of input length should be [1, 2048]')).toBe(2048);
    expect(overLengthLimitFromMessage('text exceeds the model limit of 2048 tokens')).toBe(2048);
    expect(overLengthLimitFromMessage('input length exceeds the context length')).toBeUndefined();
  });
});

describe('deriving a deterministic smaller cap', () => {
  const texts = [fatParagraph(60), 'short'];
  const largest = Math.max(...texts.map(estimateEmbedTokens));

  test('a named limit gives floor(limit × 0.6); otherwise half the largest failed estimate', () => {
    expect(deriveOverLengthChunkCap(http(400, 'Input length 1460 exceeds maximum allowed token size 512'), texts, DEFAULT_MAX_CHUNK_TOKENS)).toBe(307);
    expect(deriveOverLengthChunkCap(http(400, 'input length exceeds the context length'), texts, DEFAULT_MAX_CHUNK_TOKENS)).toBe(Math.floor(largest / 2));
    expect(deriveOverLengthChunkCap(http(400, 'input length exceeds the context length'), texts, DEFAULT_MAX_CHUNK_TOKENS))
      .toBe(deriveOverLengthChunkCap(http(400, 'input length exceeds the context length'), texts, DEFAULT_MAX_CHUNK_TOKENS));
  });

  test('a cap that is not smaller than the current one, or below the useful minimum, is null (terminal)', () => {
    expect(deriveOverLengthChunkCap(http(400, 'maximum context length is 8192 tokens'), texts, DEFAULT_MAX_CHUNK_TOKENS)).toBeNull();
    expect(deriveOverLengthChunkCap(http(400, 'maximum context length is 100 tokens'), texts, DEFAULT_MAX_CHUNK_TOKENS)).toBeNull();
    expect(deriveOverLengthChunkCap(http(400, 'input length exceeds the context length'), ['tiny'], DEFAULT_MAX_CHUNK_TOKENS)).toBeNull();
    expect(MIN_USEFUL_CHUNK_TOKENS).toBeGreaterThanOrEqual(64);
    expect(deriveOverLengthChunkCap(http(400, `maximum context length is ${Math.ceil(MIN_USEFUL_CHUNK_TOKENS / 0.6)} tokens`), texts, DEFAULT_MAX_CHUNK_TOKENS)).toBe(MIN_USEFUL_CHUNK_TOKENS);
  });
});

describe('healPageAfterOverLength against a PGLite brain', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  async function seed(slug: string, body: string) {
    await engine.putPage(slug, { type: 'note', title: 'Example', compiled_truth: body });
    const prepared = (await readProjectionSnapshot(engine, slug, 'default', { allowUnsealed: true }))!;
    await installPageProjection(engine, prepared,
      [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }], { seal: true });
    return prepared.snapshot;
  }

  test('a recognised over-length 400 on an undeclared model learns the cap, splits the page now, and the pieces fit', async () => {
    await withoutChunkTokenEnv(async () => {
      const body = fatParagraph(40);
      const snapshot = await seed('overlength-a', body);
      expect(resolveMaxChunkTokens()).toBe(DEFAULT_MAX_CHUNK_TOKENS);
      const err = http(400, 'Input length 1460 exceeds maximum allowed token size 512');
      const outcome = await healPageAfterOverLength(engine, 'overlength-a', 'default', err, [body]);
      expect(outcome).toMatchObject({ kind: 'healed', cap: 307 });
      expect(outcome.kind === 'healed' && outcome.splitCount).toBe(1);
      expect(learnedChunkCap(UNDECLARED_MODEL)).toBe(307);
      expect(resolveMaxChunkTokens()).toBe(307);
      const chunks = await engine.getChunks('overlength-a');
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        expect(estimateEmbedTokens(c.chunk_text)).toBeLessThanOrEqual(307);
        expect(c.embedded_at).toBeNull();
      }
      expect(chunks.map(c => c.chunk_text).join('')).toContain('product roadmap');
      expect((await engine.readPageSnapshot('overlength-a'))!.revision).toBe(snapshot.revision);
      expect(describeOverLengthOutcome(outcome, 'overlength-a')).toContain('307');
    });
  });

  test('without a named limit the cap halves deterministically per attempt and stops after the attempt budget', async () => {
    await withoutChunkTokenEnv(async () => {
      const body = fatParagraph(40);
      await seed('overlength-b', body);
      const err = http(400, 'input length exceeds the context length');
      const caps: number[] = [];
      let outcome = await healPageAfterOverLength(engine, 'overlength-b', 'default', err, [body]);
      expect(outcome.kind).toBe('healed');
      if (outcome.kind === 'healed') caps.push(outcome.cap);
      for (let i = 1; i < MAX_OVERLENGTH_HEAL_ATTEMPTS; i++) {
        const texts = (await engine.getChunks('overlength-b')).map(c => c.chunk_text);
        outcome = await healPageAfterOverLength(engine, 'overlength-b', 'default', err, texts);
        if (outcome.kind === 'healed') caps.push(outcome.cap);
        else break;
      }
      for (let i = 1; i < caps.length; i++) expect(caps[i]!).toBeLessThan(caps[i - 1]!);
      const texts = (await engine.getChunks('overlength-b')).map(c => c.chunk_text);
      const after = await healPageAfterOverLength(engine, 'overlength-b', 'default', err, texts);
      expect(after.kind).toBe('skipped');
      if (after.kind === 'skipped') expect(['attempts_exhausted', 'cap_floor']).toContain(after.reason);
      expect(describeOverLengthOutcome(after, 'overlength-b')).toContain('GBRAIN_MAX_CHUNK_TOKENS');
    });
  });

  test('an unrelated 400, a 5xx and a batch-level token error never rewrite the page', async () => {
    await withoutChunkTokenEnv(async () => {
      const body = fatParagraph(40);
      const snapshot = await seed('overlength-c', body);
      const before = await engine.getChunks('overlength-c');
      for (const err of [
        http(400, 'Incorrect API key provided'),
        http(500, 'input length exceeds the context length'),
        http(400, 'Too many tokens overall, split into more batches.'),
        new Error('socket hang up'),
      ]) {
        const outcome = await healPageAfterOverLength(engine, 'overlength-c', 'default', err, [body]);
        expect(outcome).toEqual({ kind: 'skipped', reason: 'not_overlength' });
        expect(describeOverLengthOutcome(outcome, 'overlength-c')).toBeNull();
      }
      const after = await engine.getChunks('overlength-c');
      expect(after.map(c => [c.id, c.chunk_text])).toEqual(before.map(c => [c.id, c.chunk_text]));
      expect(learnedChunkCap(UNDECLARED_MODEL)).toBeUndefined();
      expect((await engine.readPageSnapshot('overlength-c'))!.revision).toBe(snapshot.revision);
    });
  });

  test('a model with a declared cap, or an operator GBRAIN_MAX_CHUNK_TOKENS, is terminal: the declaration is the thing to fix', async () => {
    const body = fatParagraph(40);
    await seed('overlength-d', body);
    const err = http(400, 'Input length 1460 exceeds maximum allowed token size 512');
    configureGateway({ embedding_model: 'nvidia:nvidia/nv-embedqa-e5-v5', embedding_dimensions: 1024, env: { NVIDIA_API_KEY: 'k' } });
    await withoutChunkTokenEnv(async () => {
      const declared = await healPageAfterOverLength(engine, 'overlength-d', 'default', err, [body]);
      expect(declared).toEqual({ kind: 'skipped', reason: 'declared_cap' });
      expect(describeOverLengthOutcome(declared, 'overlength-d')).toContain('max_input_tokens');
    });
    configureGateway({ embedding_model: UNDECLARED_MODEL, embedding_dimensions: 768, env: {} });
    await withEnv({ GBRAIN_MAX_CHUNK_TOKENS: '1500' }, async () => {
      const pinned = await healPageAfterOverLength(engine, 'overlength-d', 'default', err, [body]);
      expect(pinned).toEqual({ kind: 'skipped', reason: 'declared_cap' });
    });
    expect((await engine.getChunks('overlength-d')).map(c => c.chunk_text)).toEqual([body]);
    expect(learnedChunkCap(UNDECLARED_MODEL)).toBeUndefined();
  });

  test('a learned cap is per model and cleared by the test seam', async () => {
    await withoutChunkTokenEnv(async () => {
      const body = fatParagraph(40);
      await seed('overlength-e', body);
      await healPageAfterOverLength(engine, 'overlength-e', 'default', http(400, 'maximum context length is 1024 tokens'), [body]);
      expect(learnedChunkCap(UNDECLARED_MODEL)).toBe(614);
      expect(learnedChunkCap('ollama:other-model')).toBeUndefined();
      configureGateway({ embedding_model: 'ollama:other-model', embedding_dimensions: 768, env: {} });
      expect(resolveMaxChunkTokens()).toBe(DEFAULT_MAX_CHUNK_TOKENS);
      _resetLearnedChunkCapsForTest();
      expect(learnedChunkCap(UNDECLARED_MODEL)).toBeUndefined();
    });
  });
});
