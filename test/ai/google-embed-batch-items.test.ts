/**
 * The Google embedding recipe must declare its per-request ITEM cap.
 *
 * Regression: the recipe declared `max_batch_tokens: 20_000` but no
 * `max_batch_items`. A token budget cannot bound item count — short inputs
 * (a one-line fact) stay far under 20k tokens while sailing past 100 items —
 * so `capBatchItems` never split and embed() handed the whole array to
 * batchEmbedContents, which rejects it:
 *
 *   BatchEmbedContentsRequest.requests: at most 100 requests can be in one batch
 *
 * The caller that felt it was the extract_facts cycle phase: it batch-embeds
 * a page's facts in ONE embed() call, so any page holding more than 100 facts
 * failed its embed WHOLESALE and every one of those facts was inserted with a
 * NULL embedding — dropping them out of consolidate's cosine clustering and
 * remember's semantic dedup, behind a warning that only `--json` surfaces.
 *
 * This exercises the REAL recipe (no synthetic fixture): the defect was the
 * shipped recipe's own contents, so a synthetic stand-in could not catch it.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  embed,
  __setEmbedTransportForTests,
} from '../../src/core/ai/gateway.ts';
import { google as GOOGLE_RECIPE } from '../../src/core/ai/recipes/google.ts';

afterAll(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

const DIMS = 8;
const GOOGLE_BATCH_LIMIT = 100;

function fakeEmbeddings(values: string[], dims: number): { embeddings: number[][] } {
  return { embeddings: values.map(() => Array.from({ length: dims }, () => 0.1)) };
}

function configureGoogle(): ReturnType<typeof mock> {
  configureGateway({
    embedding_model: 'google:gemini-embedding-2',
    embedding_dimensions: DIMS,
    env: { GOOGLE_GENERATIVE_AI_API_KEY: 'test-key' },
  });
  const stub = mock(async ({ values }: { values: string[] }) => fakeEmbeddings(values, DIMS));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __setEmbedTransportForTests(stub as any);
  return stub;
}

describe('the Google recipe caps batches by item count', () => {
  beforeEach(() => resetGateway());
  afterEach(() => {
    __setEmbedTransportForTests(null);
    resetGateway();
  });

  test('declares max_batch_items at the documented API limit', () => {
    expect(GOOGLE_RECIPE.touchpoints?.embedding?.max_batch_items).toBe(GOOGLE_BATCH_LIMIT);
  });

  test('165 short facts never reach the transport as one over-limit request', async () => {
    // 165 = the real page that broke (projects/preuve-llm). Each text is far
    // under the token budget, so ONLY the item cap can split this.
    const stub = configureGoogle();
    const texts = Array.from({ length: 165 }, (_, i) => `fact number ${i}`);

    const result = await embed(texts);

    expect(stub.mock.calls.length).toBeGreaterThan(1);
    for (const [arg] of stub.mock.calls) {
      expect((arg as { values: string[] }).values.length).toBeLessThanOrEqual(GOOGLE_BATCH_LIMIT);
    }
    expect(result).toHaveLength(165);
  });

  test('every input still gets exactly one vector back, in order', async () => {
    const stub = configureGoogle();
    const texts = Array.from({ length: 250 }, (_, i) => `f${i}`);

    const result = await embed(texts);

    // No input dropped or duplicated across the sub-batch seams.
    const sent = stub.mock.calls.flatMap(([arg]) => (arg as { values: string[] }).values);
    expect(sent).toEqual(texts);
    expect(result).toHaveLength(250);
  });

  test('a batch already under the cap stays a single request', async () => {
    const stub = configureGoogle();

    await embed(Array.from({ length: 12 }, (_, i) => `f${i}`));

    expect(stub).toHaveBeenCalledTimes(1);
  });
});
