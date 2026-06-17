export type AudioInput =
  | { buffer: ArrayBuffer; mimeType: string }
  | { fileRef: string };

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
  confidence: number;
}

export interface TranscriptionResult {
  text: string;
  segments?: TranscriptionSegment[];
  language: string;
  confidence: number;
  provider: string;
}

export interface STTAdapter {
  transcribe(audio: AudioInput): Promise<TranscriptionResult>;
  isAvailable(): boolean;
}

export class MockSTTAdapter implements STTAdapter {
  private delayMs: number;
  private fail: boolean;
  private language: string;

  constructor(opts?: { delayMs?: number; fail?: boolean; language?: string }) {
    this.delayMs = opts?.delayMs ?? 0;
    this.fail = opts?.fail ?? false;
    this.language = opts?.language ?? 'en';
  }

  async transcribe(_audio: AudioInput): Promise<TranscriptionResult> {
    if (this.fail) {
      throw new Error('Mock STT failure');
    }
    if (this.delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.delayMs));
    }
    return {
      text: 'This is a mock transcription of the audio input.',
      language: this.language,
      confidence: 0.95,
      provider: 'mock',
    };
  }

  isAvailable(): boolean {
    return true;
  }
}

export class DeepgramSTTAdapter implements STTAdapter {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  async transcribe(_audio: AudioInput): Promise<TranscriptionResult> {
    throw new Error('Deepgram transcription not implemented in MVP');
  }
}
