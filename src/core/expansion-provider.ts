/**
 * FORK: Provider-agnostic query expansion abstraction.
 *
 * Mirrors the embedding-provider pattern for LLM-based query expansion.
 *
 * Providers:
 *   anthropic — claude-haiku-4-5-20251001 with tool_use (default)
 *   gemini    — gemini-1.5-flash with function calling
 *
 * Config env var:
 *   GBRAIN_EXPANSION_PROVIDER=anthropic|gemini  (default: anthropic)
 */

import { AnthropicExpander } from './providers/anthropic-expander.ts';
import { GeminiExpander } from './providers/gemini-expander.ts';

export interface ExpansionProvider {
  /**
   * Returns up to 2 alternative phrasings of the query.
   * The original query is NOT included — the caller adds it.
   * Throws if the provider API call fails; caller catches and falls back.
   */
  expand(query: string): Promise<string[]>;
}

let _active: ExpansionProvider | null = null;

export function getActiveExpansionProvider(): ExpansionProvider {
  if (!_active) {
    const name = (process.env.GBRAIN_EXPANSION_PROVIDER ?? 'anthropic').toLowerCase();
    _active = name === 'gemini' ? new GeminiExpander() : new AnthropicExpander();
  }
  return _active;
}

/** Returns true if the active expansion provider's API key is present. */
export function isExpansionAvailable(): boolean {
  const name = (process.env.GBRAIN_EXPANSION_PROVIDER ?? 'anthropic').toLowerCase();
  if (name === 'gemini') {
    return !!(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
  }
  return !!process.env.ANTHROPIC_API_KEY;
}

/** Reset cached provider. Used in tests when env vars change between cases. */
export function resetActiveExpansionProvider(): void {
  _active = null;
}
