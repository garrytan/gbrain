import { createHash } from 'crypto';

export function validateSlug(slug: string): void {
  if (!slug || /\.\./.test(slug) || /^\//.test(slug) || !/^[a-z0-9][a-z0-9/_-]*$/.test(slug)) {
    throw new Error(`Invalid slug: "${slug}". Slugs must be lowercase alphanumeric with / - _ separators, no path traversal.`);
  }
}

export function contentHash(compiledTruth: string, timeline: string): string {
  return createHash('sha256').update(compiledTruth + '\n---\n' + timeline).digest('hex');
}
