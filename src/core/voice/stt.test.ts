import { describe, test, expect } from 'bun:test';
import { MockSTTAdapter, DeepgramSTTAdapter } from './stt.ts';
import type { AudioInput } from './stt.ts';

describe('MockSTTAdapter', () => {
  test('returns expected transcription text', async () => {
    const adapter = new MockSTTAdapter();
    const audio: AudioInput = { buffer: new ArrayBuffer(128), mimeType: 'audio/wav' };
    const result = await adapter.transcribe(audio);
    expect(result.text).toBe('This is a mock transcription of the audio input.');
    expect(result.language).toBe('en');
    expect(result.confidence).toBe(0.95);
    expect(result.provider).toBe('mock');
  });

  test('respects delay', async () => {
    const adapter = new MockSTTAdapter({ delayMs: 50 });
    const audio: AudioInput = { buffer: new ArrayBuffer(128), mimeType: 'audio/wav' };
    const start = Date.now();
    await adapter.transcribe(audio);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45);
  });

  test('with fail=true throws', async () => {
    const adapter = new MockSTTAdapter({ fail: true });
    const audio: AudioInput = { buffer: new ArrayBuffer(128), mimeType: 'audio/wav' };
    expect(adapter.transcribe(audio)).rejects.toThrow('Mock STT failure');
  });

  test('isAvailable returns true', () => {
    const adapter = new MockSTTAdapter();
    expect(adapter.isAvailable()).toBe(true);
  });

  test('handles AudioInput with fileRef', async () => {
    const adapter = new MockSTTAdapter();
    const audio: AudioInput = { fileRef: '/tmp/test-audio.wav' };
    const result = await adapter.transcribe(audio);
    expect(result.text).toBe('This is a mock transcription of the audio input.');
  });
});

describe('DeepgramSTTAdapter', () => {
  test('with key isAvailable returns true', () => {
    const adapter = new DeepgramSTTAdapter('test-api-key');
    expect(adapter.isAvailable()).toBe(true);
  });

  test('with empty key isAvailable returns false', () => {
    const adapter = new DeepgramSTTAdapter('');
    expect(adapter.isAvailable()).toBe(false);
  });

  test('transcribe throws placeholder error', async () => {
    const adapter = new DeepgramSTTAdapter('test-api-key');
    expect(adapter.transcribe({ buffer: new ArrayBuffer(128), mimeType: 'audio/wav' })).rejects.toThrow(
      'Deepgram transcription not implemented in MVP',
    );
  });
});
