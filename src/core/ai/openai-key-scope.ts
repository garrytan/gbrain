/** Credential-purpose policy for the key carried in OPENAI_API_KEY. */
export type OpenAIApiKeyScope = 'all' | 'embedding_only';

export function isValidOpenAIApiKeyScope(value: unknown): value is OpenAIApiKeyScope {
  return value === 'all' || value === 'embedding_only';
}

/**
 * Unknown values fail closed. Undefined preserves the historical unrestricted
 * default for installations that have not opted into credential scoping.
 */
export function isOpenAIApiKeyRestricted(value: unknown): boolean {
  return value !== undefined && value !== 'all';
}
