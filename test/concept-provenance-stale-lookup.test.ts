import { describe, expect, test } from 'bun:test';
import { replaceConceptProvenanceLinks } from '../src/core/cycle/concept-publication.ts';

describe('replaceConceptProvenanceLinks stale-edge lookup', () => {
  test('looks up each direction separately so page indexes are usable', async () => {
    const queries: string[] = [];
    const tx: any = {
      executeRaw: async (sql: string) => {
        queries.push(sql);
        return sql.includes('knowledge_revision') ? [{ revision: 'r1' }] : [];
      },
      removeLink: async () => 0,
      addLinksBatch: async () => 0,
    };
    const engine: any = { transaction: async (fn: (t: any) => unknown) => fn(tx) };
    const result = await replaceConceptProvenanceLinks(engine, 'default', 'concepts/x', [], { expectedRevision: 'r1', managed: false });
    expect(result).toEqual({ inserted: 0, retired: 0 });
    const stale = queries.find(q => q.includes("'concept-provenance'"))!;
    expect(stale).toBeDefined();
    expect(stale).toContain('UNION ALL');
    expect(stale).not.toMatch(/\)\s*OR\s*\(/);
  });
});
