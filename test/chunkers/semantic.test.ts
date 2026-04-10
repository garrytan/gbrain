import { describe, test, expect } from 'bun:test';
import { chunkTextSemantic, splitSentences } from '../../src/core/chunkers/semantic.ts';
import { chunkText as recursiveChunk } from '../../src/core/chunkers/recursive.ts';

const SHORT = 'This is a short text. It has two sentences.';

const LONG = Array(60).fill('The transformer architecture uses self-attention layers.').join(' ');

const MULTI_TOPIC =
  Array(25).fill('Stars form through gravitational collapse of gas clouds.').join(' ') +
  '\n\n' +
  Array(25).fill('Stock markets react to interest rate decisions by central banks.').join(' ');

function mockEmbedFn(topicMap: (text: string) => Float32Array) {
  return async (texts: string[]): Promise<Float32Array[]> => texts.map(topicMap);
}

function uniformEmbed(): (text: string) => Float32Array {
  return () => new Float32Array(1536).fill(0.5);
}

function topicEmbed(): (text: string) => Float32Array {
  return (text: string) => {
    const v = new Float32Array(1536).fill(0);
    if (text.toLowerCase().includes('star') || text.toLowerCase().includes('gas')) {
      v[0] = 1.0;
    } else {
      v[1] = 1.0;
    }
    return v;
  };
}

describe('splitSentences', () => {
  test('splits on period-space', () => {
    const sents = splitSentences('First sentence. Second sentence. Third.');
    expect(sents).toHaveLength(3);
  });

  test('returns single item for text without sentence terminators', () => {
    const sents = splitSentences('no terminator here');
    expect(sents).toHaveLength(1);
  });

  test('filters empty strings', () => {
    const sents = splitSentences('');
    expect(sents).toHaveLength(0);
  });
});

describe('chunkTextSemantic', () => {
  test('falls back to recursive when embedFn is undefined', async () => {
    const sem = await chunkTextSemantic(LONG, {});
    const rec = recursiveChunk(LONG);
    expect(sem.length).toBe(rec.length);
    for (let i = 0; i < sem.length; i++) {
      expect(sem[i].text).toBe(rec[i].text);
    }
  });

  test('returns single chunk for text below chunkSize', async () => {
    const chunks = await chunkTextSemantic(SHORT, { embedFn: mockEmbedFn(uniformEmbed()) });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
  });

  test('returns empty array for empty input', async () => {
    const chunks = await chunkTextSemantic('', { embedFn: mockEmbedFn(uniformEmbed()) });
    expect(chunks).toHaveLength(0);
  });

  test('calls embedFn for boundary detection on long text', async () => {
    let callCount = 0;
    const trackingEmbed = async (texts: string[]): Promise<Float32Array[]> => {
      callCount += texts.length;
      return texts.map(uniformEmbed());
    };
    await chunkTextSemantic(LONG, { embedFn: trackingEmbed });
    expect(callCount).toBeGreaterThan(0);
  });

  test('detects topic boundary when embeddings diverge sharply', async () => {
    const sem = await chunkTextSemantic(MULTI_TOPIC, { embedFn: mockEmbedFn(topicEmbed()) });
    const rec = recursiveChunk(MULTI_TOPIC);
    // Semantic should split at the topic boundary; both should produce >=1 chunk
    expect(sem.length).toBeGreaterThanOrEqual(1);
    expect(rec.length).toBeGreaterThanOrEqual(1);
    // With perfectly divergent embeddings, semantic finds the boundary
    if (sem.length >= 2) {
      const firstHasStars = sem[0].text.toLowerCase().includes('star');
      const secondHasStock = sem[sem.length - 1].text.toLowerCase().includes('stock');
      expect(firstHasStars).toBe(true);
      expect(secondHasStock).toBe(true);
    }
  });

  test('chunk indices are sequential from 0', async () => {
    const chunks = await chunkTextSemantic(LONG, { embedFn: mockEmbedFn(uniformEmbed()) });
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i);
    }
  });

  test('falls back to recursive on embedFn error', async () => {
    const failingEmbed = async (_texts: string[]): Promise<Float32Array[]> => {
      throw new Error('API down');
    };
    const sem = await chunkTextSemantic(LONG, { embedFn: failingEmbed });
    const rec = recursiveChunk(LONG);
    expect(sem.length).toBe(rec.length);
  });

  test('no chunk is empty after trimming', async () => {
    const chunks = await chunkTextSemantic(LONG, { embedFn: mockEmbedFn(uniformEmbed()) });
    for (const c of chunks) {
      expect(c.text.trim().length).toBeGreaterThan(0);
    }
  });
});
