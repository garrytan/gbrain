export interface EmbeddingProvider {
  /** Provider identifier, e.g. 'openai', 'gemini', 'anthropic' */
  name: string;
  /** Model identifier, e.g. 'text-embedding-3-large' */
  model: string;
  /** Output vector dimensions */
  dimensions: number;
  /** Embed a single text */
  embed(text: string): Promise<Float32Array>;
  /** Embed multiple texts in batch */
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}
