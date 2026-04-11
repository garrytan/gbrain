import { describe, test, expect } from 'bun:test';
import { BaseProvider } from '../../src/core/embedding/base.ts';

class MockProvider extends BaseProvider {
  readonly name = 'mock';
  readonly model = 'mock-model';
  readonly dimensions = 4;
  callCount = 0;

  protected async callAPI(texts: string[]): Promise<Float32Array[]> {
    this.callCount++;
    return texts.map(() => new Float32Array([1, 2, 3, 4]));
  }
}

class FailThenSucceedProvider extends BaseProvider {
  readonly name = 'flaky';
  readonly model = 'flaky-model';
  readonly dimensions = 4;
  attempts = 0;
  protected baseDelayMs = 10; // fast for tests

  protected async callAPI(texts: string[]): Promise<Float32Array[]> {
    this.attempts++;
    if (this.attempts < 3) throw new Error('transient');
    return texts.map(() => new Float32Array([1, 2, 3, 4]));
  }
}

class AlwaysFailProvider extends BaseProvider {
  readonly name = 'broken';
  readonly model = 'broken-model';
  readonly dimensions = 4;
  protected maxRetries = 2;
  protected baseDelayMs = 10;

  protected async callAPI(_texts: string[]): Promise<Float32Array[]> {
    throw new Error('permanent failure');
  }
}

describe('BaseProvider', () => {
  test('embed delegates to embedBatch', async () => {
    const p = new MockProvider();
    const result = await p.embed('hello');
    expect(result).toEqual(new Float32Array([1, 2, 3, 4]));
    expect(p.callCount).toBe(1);
  });

  test('embedBatch truncates text to maxChars', async () => {
    const p = new MockProvider();
    const longText = 'a'.repeat(10000);
    const result = await p.embedBatch([longText]);
    expect(result.length).toBe(1);
  });

  test('embedBatch splits into batches', async () => {
    const p = new MockProvider();
    p['batchSize'] = 2;
    const texts = ['a', 'b', 'c', 'd', 'e'];
    const result = await p.embedBatch(texts);
    expect(result.length).toBe(5);
    expect(p.callCount).toBe(3); // ceil(5/2) = 3
  });

  test('retries on transient failure then succeeds', async () => {
    const p = new FailThenSucceedProvider();
    const result = await p.embed('hello');
    expect(result).toEqual(new Float32Array([1, 2, 3, 4]));
    expect(p.attempts).toBe(3);
  });

  test('throws after exhausting retries', async () => {
    const p = new AlwaysFailProvider();
    await expect(p.embed('hello')).rejects.toThrow('permanent failure');
  });

  test('getRetryDelay uses exponential backoff with cap', () => {
    const p = new MockProvider();
    const d0 = p['getRetryDelay'](null, 0); // 4000
    const d1 = p['getRetryDelay'](null, 1); // 8000
    const d4 = p['getRetryDelay'](null, 4); // 64000
    const d10 = p['getRetryDelay'](null, 10); // capped at 120000
    expect(d0).toBe(4000);
    expect(d1).toBe(8000);
    expect(d4).toBe(64000);
    expect(d10).toBe(120000);
  });
});
