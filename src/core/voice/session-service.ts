import type { STTAdapter, AudioInput } from './stt.ts';
import type { TTSAdapter } from './tts.ts';

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

export interface VoiceSessionResult {
  sessionId: string;
  transcript: string;
  summary: string;
  tags: string[];
  audioOutput: ArrayBuffer;
  pageContent: string;
}

export interface VoiceSessionPage {
  slug: string;
  content: string;
}

function generateSlug(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `voice-session-${ts}-${rand}`;
}

function generateSummary(transcript: string): string {
  if (transcript.length <= 200) return transcript;
  return transcript.slice(0, 200) + '...';
}

export class VoiceSessionService {
  private stt: STTAdapter;
  private tts: TTSAdapter;
  private onSave?: (session: VoiceSessionPage) => Promise<void>;

  constructor(opts: {
    stt: STTAdapter;
    tts: TTSAdapter;
    onSave?: (session: VoiceSessionPage) => Promise<void>;
  }) {
    this.stt = opts.stt;
    this.tts = opts.tts;
    this.onSave = opts.onSave;
  }

  async processAudio(
    audio: AudioInput,
    context?: { title?: string; tags?: string[] },
  ): Promise<VoiceSessionResult> {
    const tags = context?.tags ?? [];
    const slug = generateSlug();
    const sessionId = slug;

    let transcriptionResult;
    try {
      transcriptionResult = await this.stt.transcribe(audio);
    } catch (err) {
      throw new SessionError(
        `STT transcription failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const transcript = transcriptionResult.text;
    const summary = generateSummary(transcript);

    const answer = `I processed your input about: ${transcript.slice(0, 100)}`;

    let audioOutput: ArrayBuffer;
    try {
      audioOutput = await this.tts.synthesize(answer);
    } catch {
      audioOutput = new ArrayBuffer(0);
    }

    const pageContent = buildPageContent({
      title: context?.title ?? 'Voice Session',
      transcript,
      summary,
      tags,
      slug,
    });

    if (this.onSave) {
      await this.onSave({ slug, content: pageContent });
    }

    return {
      sessionId,
      transcript,
      summary,
      tags,
      audioOutput,
      pageContent,
    };
  }
}

function buildPageContent(opts: {
  title: string;
  transcript: string;
  summary: string;
  tags: string[];
  slug: string;
}): string {
  const tagsYaml = opts.tags.length > 0
    ? `\ntags: [${opts.tags.map(t => `"${t}"`).join(', ')}]`
    : '';

  return [
    '---',
    `type: voice_session`,
    `source: voice`,
    `confidence: 0.7`,
    `consent: true`,
    `slug: "${opts.slug}"`,
    `title: "${opts.title}"`,
    tagsYaml,
    '---',
    '',
    '## Transcript',
    '',
    opts.transcript,
    '',
    '## Summary',
    '',
    opts.summary,
    '',
  ].join('\n');
}
