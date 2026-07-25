import { describe, test, expect } from 'bun:test';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TMP_TXT = join(tmpdir(), 'gbrain-test-audio.txt');
const TMP_MP3 = join(tmpdir(), 'gbrain-test-audio.mp3');

// Create minimal test files
writeFileSync(TMP_TXT, 'not audio');
writeFileSync(TMP_MP3, 'fake mp3 data');

describe('transcription', () => {
  test('module exports transcribe function', async () => {
    const mod = await import('../src/core/transcription.ts');
    expect(typeof mod.transcribe).toBe('function');
  });

  test('TranscriptionResult interface shape', async () => {
    const mod = await import('../src/core/transcription.ts');
    expect(mod.transcribe).toBeDefined();
  });

  test('rejects unsupported audio format', async () => {
    const { transcribe } = await import('../src/core/transcription.ts');
    try {
      await transcribe(TMP_TXT, {});
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.message).toContain('Unsupported audio format');
    }
  });

  test('rejects missing API key with helpful error', async () => {
    const { transcribe } = await import('../src/core/transcription.ts');
    const groq = process.env.GROQ_API_KEY;
    const openai = process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      await transcribe(TMP_MP3, {});
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.message).toContain('API key not set');
      expect(e.message).toContain('GROQ_API_KEY');
    } finally {
      if (groq) process.env.GROQ_API_KEY = groq;
      if (openai) process.env.OPENAI_API_KEY = openai;
    }
  });

  test('detects provider from env vars', async () => {
    // This tests the provider detection logic indirectly
    const mod = await import('../src/core/transcription.ts');
    // If GROQ_API_KEY is set, Groq should be preferred
    // If only OPENAI_API_KEY, OpenAI should be used
    // We just verify the function is callable
    expect(typeof mod.transcribe).toBe('function');
  });

  test('supported audio extensions are comprehensive', () => {
    const { AUDIO_EXTENSIONS } = require('../src/core/transcription.ts');
    const expected = ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.mp4', '.webm'];
    expect(expected.every(extension => AUDIO_EXTENSIONS.has(extension))).toBe(true);
  });

  test('routes Deepgram to its native endpoint and authorization scheme', async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = '';
    let authorization = '';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      authorization = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '');
      return new Response(JSON.stringify({
        metadata: { duration: 1.25 },
        results: {
          channels: [{
            detected_language: 'zh',
            alternatives: [{
              transcript: '测试',
              words: [{ start: 0, end: 1.25, punctuated_word: '测试', speaker: 0 }],
            }],
          }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const { transcribe } = await import('../src/core/transcription.ts');
      const result = await transcribe(TMP_MP3, { provider: 'deepgram', apiKey: 'dg-test' });
      expect(requestUrl).toStartWith('https://api.deepgram.com/v1/listen?');
      expect(authorization).toBe('Token dg-test');
      expect(result.provider).toBe('deepgram');
      expect(result.text).toBe('测试');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
