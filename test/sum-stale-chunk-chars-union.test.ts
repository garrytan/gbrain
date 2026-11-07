import { describe, expect, test } from 'bun:test';
import { sumStaleChunkChars } from '../src/core/engine-sql/chunks.ts';

describe('sumStaleChunkChars with a signature', () => {
  test('splits the NULL-embedding and signature-drift arms into UNION ALL', async () => {
    const seen: string[] = [];
    const exec = {
      unsafe: async (text: string) => {
        seen.push(text);
        return { rows: [{ chars: '7' }] };
      },
    };
    const total = await sumStaleChunkChars(exec as never, 'embedding', { signature: 'm:1' });
    expect(total).toBe(7);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('UNION ALL');
    expect(seen[0]).not.toMatch(/IS NULL OR[^)]*embedding_signature/);
  });
});
