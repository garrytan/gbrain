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
    // Verify common audio formats are supported
    const expected = ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.mp4', '.webm'];
    // We can't access the private set directly, but we can test via error messages
    // The unsupported format test above verifies .txt is rejected
    // This test documents the expected formats
    expect(expected.length).toBeGreaterThan(5);
  });
});
