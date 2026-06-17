export interface TTSAdapter {
  synthesize(text: string, voice?: string): Promise<ArrayBuffer>;
  isAvailable(): boolean;
}

export class MockTTSAdapter implements TTSAdapter {
  private delayMs: number;
  private fail: boolean;

  constructor(opts?: { delayMs?: number; fail?: boolean }) {
    this.delayMs = opts?.delayMs ?? 0;
    this.fail = opts?.fail ?? false;
  }

  async synthesize(_text: string, _voice?: string): Promise<ArrayBuffer> {
    if (this.fail) {
      throw new Error('Mock TTS failure');
    }
    if (this.delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.delayMs));
    }
    return new ArrayBuffer(64);
  }

  isAvailable(): boolean {
    return true;
  }
}

export class SupertonicTTSAdapter implements TTSAdapter {
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:8080/v1') {
    this.baseUrl = baseUrl;
  }

  isAvailable(): boolean {
    return true;
  }

  async synthesize(_text: string, _voice?: string): Promise<ArrayBuffer> {
    throw new Error('Supertonic TTS not implemented in MVP');
  }
}
