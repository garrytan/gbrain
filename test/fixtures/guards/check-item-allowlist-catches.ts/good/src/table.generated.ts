import { OperationError } from './contract.ts';

const SKIP = new Set(['page_not_found', 'revision_conflict']);

export async function importAll(slugs: string[], put: (slug: string) => Promise<void>): Promise<string[]> {
  const skipped: string[] = [];
  for (const slug of slugs) {
    try {
      await put(slug);
    } catch (error) {
      if (!(error instanceof OperationError) || !SKIP.has(error.code)) throw error;
      skipped.push(slug);
    }
  }
  return skipped;
}
