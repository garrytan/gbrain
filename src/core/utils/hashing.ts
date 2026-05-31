import { createHash } from 'crypto';
import type {
  PageType,
} from '../types.ts';

export interface ImportContentHashInput {
  title: string;
  type: PageType;
  compiled_truth: string;
  timeline?: string;
  frontmatter?: Record<string, unknown>;
  tags?: string[];
}

/**
 * SHA-256 hash of compiled_truth + timeline, used for low-level page writes.
 */
export function contentHash(compiledTruth: string, timeline: string): string {
  return createHash('sha256').update(compiledTruth + '\n---\n' + timeline).digest('hex');
}

export function chunkContentHash(chunkText: string, chunkSource: string): string {
  return createHash('md5').update(`${chunkSource}\n${chunkText}`).digest('hex');
}

/**
 * Hash contract for markdown imports and re-import idempotency.
 */
export function importContentHash(input: ImportContentHashInput): string {
  return createHash('sha256')
    .update(JSON.stringify({
      title: input.title,
      type: input.type,
      compiled_truth: input.compiled_truth,
      timeline: input.timeline ?? '',
      frontmatter: canonicalizeJsonValue(input.frontmatter ?? {}),
      tags: [...(input.tags ?? [])].sort(),
    }))
    .digest('hex');
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalizeJsonValue(nested)])
    );
  }
  return value;
}
