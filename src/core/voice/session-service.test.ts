import { describe, test, expect } from 'bun:test';
import { MockSTTAdapter } from './stt.ts';
import { MockTTSAdapter } from './tts.ts';
import { VoiceSessionService, SessionError } from './session-service.ts';
import type { AudioInput } from './stt.ts';

describe('VoiceSessionService', () => {
  const audio: AudioInput = { buffer: new ArrayBuffer(128), mimeType: 'audio/wav' };

  test('processAudio with mock STT+TTS returns transcript and audio', async () => {
    const stt = new MockSTTAdapter();
    const tts = new MockTTSAdapter();
    const service = new VoiceSessionService({ stt, tts });

    const result = await service.processAudio(audio);

    expect(result.transcript).toBe('This is a mock transcription of the audio input.');
    expect(result.summary).toBe('This is a mock transcription of the audio input.');
    expect(result.audioOutput).toBeInstanceOf(ArrayBuffer);
    expect(result.audioOutput.byteLength).toBe(64);
    expect(result.sessionId).toBeTruthy();
    expect(result.tags).toEqual([]);
  });

  test('returns result with context tags and title', async () => {
    const stt = new MockSTTAdapter();
    const tts = new MockTTSAdapter();
    const service = new VoiceSessionService({ stt, tts });

    const result = await service.processAudio(audio, {
      title: 'Test Meeting',
      tags: ['person:anna', 'company:acme'],
    });

    expect(result.tags).toEqual(['person:anna', 'company:acme']);
    expect(result.pageContent).toContain('person:anna');
    expect(result.pageContent).toContain('company:acme');
  });

  test('session is saved via onSave callback', async () => {
    const stt = new MockSTTAdapter();
    const tts = new MockTTSAdapter();
    let savedSession: { slug: string; content: string } | undefined;
    const service = new VoiceSessionService({
      stt,
      tts,
      onSave: async (session) => {
        savedSession = session;
      },
    });

    const result = await service.processAudio(audio);

    expect(savedSession).toBeDefined();
    expect(savedSession!.slug).toBe(result.sessionId);
    expect(savedSession!.content).toBe(result.pageContent);
  });

  test('session markdown contains frontmatter + transcript + summary', async () => {
    const stt = new MockSTTAdapter();
    const tts = new MockTTSAdapter();
    const service = new VoiceSessionService({ stt, tts });

    const result = await service.processAudio(audio);

    expect(result.pageContent).toContain('---');
    expect(result.pageContent).toContain('type: voice_session');
    expect(result.pageContent).toContain('source: voice');
    expect(result.pageContent).toContain('confidence: 0.7');
    expect(result.pageContent).toContain('consent: true');
    expect(result.pageContent).toContain('## Transcript');
    expect(result.pageContent).toContain(result.transcript);
    expect(result.pageContent).toContain('## Summary');
    expect(result.pageContent).toContain(result.summary);
  });

  test('STT failure throws SessionError', async () => {
    const stt = new MockSTTAdapter({ fail: true });
    const tts = new MockTTSAdapter();
    const service = new VoiceSessionService({ stt, tts });

    expect(service.processAudio(audio)).rejects.toThrow(SessionError);
    expect(service.processAudio(audio)).rejects.toThrow('STT transcription failed');
  });

  test('TTS failure still returns result with empty audioOutput', async () => {
    const stt = new MockSTTAdapter();
    const tts = new MockTTSAdapter({ fail: true });
    const service = new VoiceSessionService({ stt, tts });

    const result = await service.processAudio(audio);

    expect(result.transcript).toBe('This is a mock transcription of the audio input.');
    expect(result.audioOutput).toBeInstanceOf(ArrayBuffer);
    expect(result.audioOutput.byteLength).toBe(0);
  });
});
