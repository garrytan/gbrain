import { describe, test, expect } from 'bun:test';
import { MockTTSAdapter, SupertonicTTSAdapter } from './tts.ts';

describe('MockTTSAdapter', () => {
  test('returns ArrayBuffer', async () => {
    const adapter = new MockTTSAdapter();
    const result = await adapter.synthesize('Hello world');
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result.byteLength).toBe(64);
  });

  test('respects delay', async () => {
    const adapter = new MockTTSAdapter({ delayMs: 50 });
    const start = Date.now();
    await adapter.synthesize('Hello');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45);
  });

  test('with fail=true throws', async () => {
    const adapter = new MockTTSAdapter({ fail: true });
    expect(adapter.synthesize('Hello')).rejects.toThrow('Mock TTS failure');
  });

  test('isAvailable returns true', () => {
    const adapter = new MockTTSAdapter();
    expect(adapter.isAvailable()).toBe(true);
  });
});

describe('SupertonicTTSAdapter', () => {
  test('isAvailable returns true', () => {
    const adapter = new SupertonicTTSAdapter();
    expect(adapter.isAvailable()).toBe(true);
  });

  test('default baseUrl is localhost:8080/v1', () => {
    const adapter = new SupertonicTTSAdapter();
    expect(adapter).toBeDefined();
  });

  test('synthesize throws placeholder error', async () => {
    const adapter = new SupertonicTTSAdapter();
    expect(adapter.synthesize('Hello')).rejects.toThrow('Supertonic TTS not implemented in MVP');
  });
});
