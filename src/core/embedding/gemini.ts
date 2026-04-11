import { GoogleGenAI } from '@google/genai';
import { BaseProvider } from './base.ts';

export class GeminiProvider extends BaseProvider {
  readonly name = 'gemini';
  readonly model: string;
  readonly dimensions: number;
  private client: GoogleGenAI | null = null;

  constructor(model = 'gemini-embedding-2-preview', dimensions = 1536) {
    super();
    this.model = model;
    this.dimensions = dimensions;
  }

  private getClient(): GoogleGenAI {
    if (!this.client) {
      const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error('GOOGLE_API_KEY or GEMINI_API_KEY environment variable is required for Gemini embedding provider');
      this.client = new GoogleGenAI({ apiKey });
    }
    return this.client;
  }

  protected async callAPI(texts: string[]): Promise<Float32Array[]> {
    const response = await this.getClient().models.embedContent({
      model: this.model,
      contents: texts.map(t => ({ parts: [{ text: t }] })),
      config: { outputDimensionality: this.dimensions },
    });
    return (response.embeddings || []).map(
      e => new Float32Array(e.values || []),
    );
  }
}
