import { loadConfigFileOnly } from './config.ts';
import { opError } from './ops/contract.ts';

export interface SourceLocalReferenceLimits {
  maxPages: number;
  maxBytes: number;
}

export const DEFAULT_REFERENCE_LIMITS: Readonly<SourceLocalReferenceLimits> = {
  maxPages: 100_000,
  maxBytes: 16 * 1024 ** 2,
};

export const REFERENCE_LIMIT_KEYS = ['links.reference_index_max_pages', 'links.reference_index_max_bytes'] as const;

/** Shared by config set and runtime reads; zero never disables the guard. */
export function parseReferenceLimit(key: string, raw: unknown): number {
  const text = typeof raw === 'number' || typeof raw === 'string' ? String(raw) : '';
  const value = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(value)) {
    throw opError('invalid_params', `${key} must be a positive safe integer.`,
      `Set ${key} to a positive whole number, or use gbrain config unset ${key} to restore the default.`);
  }
  return value;
}

/** Host file settings also work for database-free inspection. Environment wins. */
export function readSourceLocalReferenceLimits(): SourceLocalReferenceLimits {
  const links = loadConfigFileOnly()?.links;
  return {
    maxPages: parseReferenceLimit(REFERENCE_LIMIT_KEYS[0], process.env.GBRAIN_LINKS_REFERENCE_INDEX_MAX_PAGES
      ?? links?.reference_index_max_pages ?? DEFAULT_REFERENCE_LIMITS.maxPages),
    maxBytes: parseReferenceLimit(REFERENCE_LIMIT_KEYS[1], process.env.GBRAIN_LINKS_REFERENCE_INDEX_MAX_BYTES
      ?? links?.reference_index_max_bytes ?? DEFAULT_REFERENCE_LIMITS.maxBytes),
  };
}
